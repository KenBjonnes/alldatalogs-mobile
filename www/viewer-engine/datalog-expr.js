/* =================================================================================================
 * datalog-expr.js -- the BigData safe expression engine (math channels + sample filters).
 *
 * WHAT THIS IS
 *   One engine behind two features of the "Histograms" analysis view (modeled on VCM Scanner):
 *     (1) math / calculated channels, e.g.   (([Lambda Bank 1] / [Commanded Lambda]) - 1) * 100
 *     (2) sample filters, e.g.   [Throttle Position] > 50 and [Engine RPM] > 2500
 *                                and held([Throttle Position] > 50, 500, 500)
 *   Source text -> tokenizer -> recursive-descent parser -> AST -> tree of closures. Nothing is ever
 *   executed as code: no dynamic evaluation of source strings, no Function constructor, no `with`.
 *   No DOM. Loads as a plain <script> (exposes ONE global, `DatalogExpr`) and under node require().
 *
 * GRAMMAR (precedence low -> high; keywords are case-insensitive)
 *   ternary    c ? a : b
 *   or         or  ||
 *   and        and  &&
 *   not        not  !                (prefix; binds looser than a comparison and ONLY here, so
 *                                     `not [X] > 2` = not ([X] > 2) and `2 * not 1` is an error)
 *   compare    <  <=  >  >=  ==  !=  =      ('=' is an alias of '=='; a < b < c chains like Python)
 *   additive   +  -
 *   multiply   *  /  %
 *   unary      -x
 *   power      x ^ y                 (right-assoc: 2^3^2 = 512; binds tighter than unary: -2^2 = -4)
 *   primary    number | 'string' | [Channel Name] | "Channel Name" | constant | fn(args) | ( expr )
 *   numbers    12   1.5   .5   1e3   (negatives via unary minus)     constants: pi e true false nan
 *   channels   [Engine RPM]  -- any chars except ']' (units, parens, slashes ok); inner whitespace trimmed.
 *              "Engine RPM" is accepted as an alias. 'text' (single quotes) is a STRING LITERAL, used
 *              for categorical label comparisons: [Gear] == '4', [Trans In Gear] == 'No'.
 *
 * DATA MODEL / SEMANTICS
 *   - Series are index-aligned number[] (or Float64Array); missing values are NaN. ctx.time is an
 *     ascending number[] in SECONDS and may be NON-uniformly spaced.
 *   - NaN propagates through arithmetic and scalar functions. Any comparison involving NaN is false
 *     (0). Booleans are 1/0. Truthy = non-zero and not NaN (so `not nan` = 1 and `nan and x` = 0).
 *   - Division by zero, overflow and log of <= 0 all give NaN, never Infinity: every operator and
 *     function that can overflow is clamped to NaN, ±Infinity in a series reads as NaN, and a number
 *     literal too large for a double (1e400) is a syntax error.
 *   - Categorical channels are level INDICES with a `levels` label table. Labels are what users see,
 *     so every comparison goes through the LABEL, never the raw index:
 *       [Gear] == '4'   sample's label === '4'. A sample WITHOUT a label (NaN / index outside the
 *                       table) is 0 for both '==' and '!='. Label absent from this log -> '==' always
 *                       false, '!=' true for every labelled sample. Never throws.
 *       [Gear] == 4     Number(label of sample) === 4  -- the numeric literal compares the LABEL, not
 *                       the index ('4', '4.0' and ' 4' all match) through the SAME label-match path
 *                       as the string form, so [Gear] != 4 is 1 for a non-numeric label such as 'No'.
 *       [Gear] >= 3, [Gear] * 10   a categorical in numeric context yields Number(label); NaN when
 *                       the label is not numeric ('No', 'D', ...).
 *       [RPM] == '2500' numeric channel vs string literal: Number(literal); non-numeric -> false.
 *   - Window functions take sizes in MILLISECONDS and are computed per sample from the TIME array:
 *       window(i) = samples with t in [t_i - backMs/1000, t_i + fwdMs/1000] inclusive (fwdMs default 0,
 *       backMs may be 0 for pure-forward windows; sample i is always included). Forward windows are
 *       fine because completed logs are analyzed. NaN inputs are skipped, not propagated.
 *       held() returns 0 when the requested window is cut off by the log's start/end (safer for
 *       transient rejection) and also when the window is not COVERED by samples: every sample
 *       interval overlapping the window (the one straddling its start, the ones inside it, the one
 *       straddling its end) must be at most G = 2 x the log's median sample period. So a lone sample
 *       after a logging pause gives 0 instead of passing on 0 ms of history, while a window shorter
 *       than the local sample spacing simply reduces to cond at the current sample. Numeric window
 *       functions use the samples that exist and return NaN when the window has no finite sample.
 *       Window functions require an ascending, finite time axis; otherwise they fail to compile
 *       ('time axis is not ascending') while other expressions on the same log still work.
 *     All window functions are O(N) total (two-pointer bounds, sliding sums with periodic
 *     re-centering, monotonic deque, prefix counts). Results are computed lazily on the first
 *     evaluation and cached, so compile once / evaluate many.
 *
 * API (see the bottom of the file):  parse, compile, buildSimpleFilter, parseSimpleFilter,
 *   listFunctions, VERSION.  compile() never throws for bad input; it returns ok:false + {message,pos}.
 * =============================================================================================== */
(function (global) {
  'use strict';

  var VERSION = 1;
  /** Seconds. Makes inclusive window edges robust to float rounding (t - back vs t[0], etc.). */
  var EPS = 1e-9;

  // ================================================================================================
  // 0. Errors + numeric helpers
  // ================================================================================================
  function ExprError(message, pos) { this.message = message; this.pos = pos; }
  function fail(message, pos) { throw new ExprError(message, pos); }
  function errorFrom(e) {
    if (e instanceof ExprError) { return { message: e.message, pos: e.pos }; }
    return { message: String(e && e.message ? e.message : e), pos: 0 };
  }

  function isFin(v) { return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity; }
  function finiteOrNaN(v) { return (v === Infinity || v === -Infinity) ? NaN : v; }
  // Truthiness is inlined everywhere as (v === v && v !== 0): non-zero and not NaN.
  /** Strict string -> number: '' / whitespace / non-numeric -> NaN. */
  function toNum(s) {
    var str = String(s).replace(/^\s+|\s+$/g, '');
    if (!str) { return NaN; }
    var v = Number(str);
    return isFin(v) ? v : NaN;
  }
  var log10 = Math.log10 || function (x) { return Math.log(x) / Math.LN10; };
  function constFn(v) { return function () { return v; }; }

  // ================================================================================================
  // 1. Function table (drives the parser's arity check, the evaluator and listFunctions())
  // ================================================================================================
  var FUNCTIONS = {
    abs:      { kind: 'scalar', min: 1, max: 1, args: 'x', doc: 'Absolute value of x.' },
    min:      { kind: 'scalar', min: 1, max: Infinity, args: 'a, b, ...', doc: 'Smallest argument (per sample). NaN if any argument is NaN. For a time-window minimum use minw().' },
    max:      { kind: 'scalar', min: 1, max: Infinity, args: 'a, b, ...', doc: 'Largest argument (per sample). NaN if any argument is NaN. For a time-window maximum use maxw().' },
    floor:    { kind: 'scalar', min: 1, max: 1, args: 'x', doc: 'Round x down to an integer.' },
    ceil:     { kind: 'scalar', min: 1, max: 1, args: 'x', doc: 'Round x up to an integer.' },
    round:    { kind: 'scalar', min: 1, max: 1, args: 'x', doc: 'Round x to the nearest integer.' },
    sqrt:     { kind: 'scalar', min: 1, max: 1, args: 'x', doc: 'Square root; NaN for x < 0.' },
    exp:      { kind: 'scalar', min: 1, max: 1, args: 'x', doc: 'e raised to the power x.' },
    log:      { kind: 'scalar', min: 1, max: 1, args: 'x', doc: 'Natural logarithm; NaN for x <= 0.' },
    log10:    { kind: 'scalar', min: 1, max: 1, args: 'x', doc: 'Base-10 logarithm; NaN for x <= 0.' },
    pow:      { kind: 'scalar', min: 2, max: 2, args: 'x, y', doc: 'x raised to the power y (same as x ^ y).' },
    clamp:    { kind: 'scalar', min: 3, max: 3, args: 'x, lo, hi', doc: 'Limit x to the range [lo, hi].' },
    'if':     { kind: 'scalar', min: 3, max: 3, args: 'cond, a, b', doc: 'a when cond is true, otherwise b (same as cond ? a : b).' },
    isnan:    { kind: 'scalar', min: 1, max: 1, args: 'x', doc: '1 when x is NaN (missing), otherwise 0.' },
    isfinite: { kind: 'scalar', min: 1, max: 1, args: 'x', doc: '1 when x is a finite number, otherwise 0.' },
    sign:     { kind: 'scalar', min: 1, max: 1, args: 'x', doc: '-1, 0 or 1 by the sign of x; NaN stays NaN.' },

    avg:      { kind: 'window', min: 2, max: 3, args: 'x, backMs[, fwdMs]', doc: 'Mean of x over the samples from backMs before to fwdMs after the current sample (NaN samples skipped; NaN if the window has none).' },
    wavg:     { alias: 'avg' },
    minw:     { kind: 'window', min: 2, max: 3, args: 'x, backMs[, fwdMs]', doc: 'Minimum of x over the time window (NaN samples skipped).' },
    wmin:     { alias: 'minw' },
    maxw:     { kind: 'window', min: 2, max: 3, args: 'x, backMs[, fwdMs]', doc: 'Maximum of x over the time window (NaN samples skipped).' },
    wmax:     { alias: 'maxw' },
    sum:      { kind: 'window', min: 2, max: 3, args: 'x, backMs[, fwdMs]', doc: 'Sum of x over the time window (NaN samples skipped).' },
    slope:    { kind: 'window', min: 2, max: 3, args: 'x, backMs[, fwdMs]', doc: 'Least-squares slope of x over the time window, in x-units per SECOND (NaN with fewer than 2 samples).' },
    delta:    { kind: 'window', min: 2, max: 3, args: 'x, backMs[, fwdMs]', doc: 'Last finite value in the time window minus the first finite value.' },
    held:     { kind: 'window', min: 2, max: 3, args: 'cond, backMs[, fwdMs]', doc: '1 when cond is true at EVERY sample in the time window; 0 if the window is cut off by the start or end of the log. Removes tip-in/tip-out transients.' },
    count:    { kind: 'window', min: 2, max: 3, args: 'cond, backMs[, fwdMs]', doc: 'Number of samples in the time window where cond is true.' },
    prev:     { kind: 'window', min: 2, max: 2, args: 'x, n', doc: 'Value of x n samples earlier (NaN before the start of the log).' },
    next:     { kind: 'window', min: 2, max: 2, args: 'x, n', doc: 'Value of x n samples later (NaN past the end of the log).' },
    dt:       { kind: 'window', min: 0, max: 0, args: '', doc: 'Seconds since the previous sample (NaN at the first sample).' },
    t:        { kind: 'window', min: 0, max: 0, args: '', doc: 'Time of the current sample, in seconds.' }
  };
  var TIME_FUNCTIONS = { avg: 1, minw: 1, maxw: 1, sum: 1, slope: 1, delta: 1, held: 1, count: 1, dt: 1, t: 1 };

  function listFunctions() {
    var out = [], names = Object.keys(FUNCTIONS), i, j;
    for (i = 0; i < names.length; i++) {
      var spec = FUNCTIONS[names[i]];
      if (spec.alias) { continue; }
      var aliases = [];
      for (j = 0; j < names.length; j++) { if (FUNCTIONS[names[j]].alias === names[i]) { aliases.push(names[j]); } }
      out.push({ name: names[i], args: spec.args, kind: spec.kind, doc: spec.doc, aliases: aliases });
    }
    return out;
  }

  // ================================================================================================
  // 2. Tokenizer
  // ================================================================================================
  var KEYWORDS = { 'and': 1, 'or': 1, 'not': 1, 'true': 1, 'false': 1, 'pi': 1, 'e': 1, 'nan': 1 };
  var TWO_CHAR_OPS = { '<=': 1, '>=': 1, '==': 1, '!=': 1, '&&': 1, '||': 1 };
  var ONE_CHAR_OPS = { '<': 1, '>': 1, '=': 1, '!': 1, '+': 1, '-': 1, '*': 1, '/': 1, '%': 1, '^': 1, '(': 1, ')': 1, ',': 1, '?': 1, ':': 1 };
  var NUM_RE = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
  var IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

  function tokenize(src) {
    var tokens = [], i = 0, n = src.length;
    while (i < n) {
      var ch = src.charAt(i), start = i;
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
      if (ch === '[' || ch === '"') {                              // channel reference
        var close = ch === '[' ? ']' : '"';
        var end = src.indexOf(close, i + 1);
        if (end < 0) { fail('Unterminated channel reference (missing ' + close + ')', start); }
        var name = src.slice(i + 1, end).replace(/^\s+|\s+$/g, '');
        if (!name) { fail('Empty channel reference', start); }
        tokens.push({ type: 'ref', value: name, pos: start });
        i = end + 1; continue;
      }
      if (ch === "'") {                                            // string literal
        var s = '', j = i + 1, closed = false;
        while (j < n) {
          var c = src.charAt(j);
          if (c === '\\' && j + 1 < n) { s += src.charAt(j + 1); j += 2; continue; }
          if (c === "'") { closed = true; j++; break; }
          s += c; j++;
        }
        if (!closed) { fail("Unterminated string literal (missing ')", start); }
        tokens.push({ type: 'str', value: s, pos: start });
        i = j; continue;
      }
      var rest = src.slice(i);
      var m = NUM_RE.exec(rest);
      if (m) {
        var nv = parseFloat(m[0]);
        if (!isFin(nv)) { fail('Number literal is too large', start); }      // 1e400 -> Infinity: never
        tokens.push({ type: 'num', value: nv, pos: start }); i += m[0].length; continue;
      }
      m = IDENT_RE.exec(rest);
      if (m) {
        var low = m[0].toLowerCase();
        tokens.push(KEYWORDS[low] ? { type: 'kw', value: low, pos: start } : { type: 'ident', value: m[0], pos: start });
        i += m[0].length; continue;
      }
      var two = src.substr(i, 2);
      if (TWO_CHAR_OPS[two]) { tokens.push({ type: 'op', value: two, pos: start }); i += 2; continue; }
      if (ONE_CHAR_OPS[ch]) { tokens.push({ type: 'op', value: ch, pos: start }); i += 1; continue; }
      fail("Unexpected character '" + ch + "'", start);
    }
    tokens.push({ type: 'eof', value: null, pos: n });
    return tokens;
  }

  // ================================================================================================
  // 3. Parser (recursive descent) -> AST
  //    node types: num str ref neg not and or bin(op) cmp(op) ternary call. Parenthesized
  //    sub-expressions get `paren: true` so parseSimpleFilter can reproduce the builder's groups.
  // ================================================================================================
  var CMP_OPS = { '<': 1, '<=': 1, '>': 1, '>=': 1, '==': 1, '!=': 1, '=': 1 };

  function parseTokens(tokens) {
    var p = 0;
    function peek() { return tokens[p]; }
    function next() { return tokens[p++]; }
    function isOp(tok, v) { return tok.type === 'op' && tok.value === v; }
    function isKw(tok, v) { return tok.type === 'kw' && tok.value === v; }
    function describe(tok) {
      if (tok.type === 'eof') { return 'end of expression'; }
      if (tok.type === 'ref') { return "'[" + tok.value + "]'"; }
      if (tok.type === 'str') { return "string '" + tok.value + "'"; }
      return "'" + tok.value + "'";
    }
    function expectOp(v) {
      var tok = peek();
      if (!isOp(tok, v)) { fail("Expected '" + v + "' but found " + describe(tok), tok.pos); }
      return next();
    }

    function parseExpr() { return parseTernary(); }
    function parseTernary() {
      var cond = parseOr();
      if (isOp(peek(), '?')) {
        var q = next();
        var a = parseTernary();
        expectOp(':');
        var b = parseTernary();
        return { type: 'ternary', cond: cond, a: a, b: b, pos: q.pos };
      }
      return cond;
    }
    function parseOr() {
      var left = parseAnd();
      while (isKw(peek(), 'or') || isOp(peek(), '||')) {
        var tok = next();
        left = { type: 'or', left: left, right: parseAnd(), pos: tok.pos };
      }
      return left;
    }
    function parseAnd() {
      var left = parseNot();
      while (isKw(peek(), 'and') || isOp(peek(), '&&')) {
        var tok = next();
        left = { type: 'and', left: left, right: parseNot(), pos: tok.pos };
      }
      return left;
    }
    function parseNot() {
      var tok = peek();
      if (isKw(tok, 'not') || isOp(tok, '!')) { next(); return { type: 'not', arg: parseNot(), pos: tok.pos }; }
      return parseComparison();
    }
    function parseComparison() {
      var left = parseAdditive(), result = null, tok;
      while ((tok = peek()).type === 'op' && CMP_OPS[tok.value]) {
        next();
        var right = parseAdditive();
        var cmp = { type: 'cmp', op: tok.value === '=' ? '==' : tok.value, left: left, right: right, pos: tok.pos };
        result = result ? { type: 'and', left: result, right: cmp, pos: tok.pos } : cmp;   // a < b < c
        left = right;
      }
      return result || left;
    }
    function parseAdditive() {
      var left = parseMul();
      while (isOp(peek(), '+') || isOp(peek(), '-')) {
        var tok = next();
        left = { type: 'bin', op: tok.value, left: left, right: parseMul(), pos: tok.pos };
      }
      return left;
    }
    function parseMul() {
      var left = parseUnary();
      while (isOp(peek(), '*') || isOp(peek(), '/') || isOp(peek(), '%')) {
        var tok = next();
        left = { type: 'bin', op: tok.value, left: left, right: parseUnary(), pos: tok.pos };
      }
      return left;
    }
    function parseUnary() {
      var tok = peek();
      if (isOp(tok, '-')) { next(); return { type: 'neg', arg: parseUnary(), pos: tok.pos }; }
      if (isOp(tok, '+')) { next(); return parseUnary(); }
      // `not` / `!` bind at ONE level only (parseNot, looser than comparisons): `2 * not 1` is an error.
      return parsePower();
    }
    function parsePower() {
      var base = parsePrimary();
      if (isOp(peek(), '^')) {
        var tok = next();
        return { type: 'bin', op: '^', left: base, right: parseUnary(), pos: tok.pos };   // right-assoc, allows 2^-1
      }
      return base;
    }
    function parsePrimary() {
      var tok = next();
      switch (tok.type) {
        case 'num': return { type: 'num', value: tok.value, pos: tok.pos };
        case 'str': return { type: 'str', value: tok.value, pos: tok.pos };
        case 'ref': return { type: 'ref', name: tok.value, pos: tok.pos };
        case 'kw':
          if (tok.value === 'true') { return { type: 'num', value: 1, bool: true, pos: tok.pos }; }
          if (tok.value === 'false') { return { type: 'num', value: 0, bool: true, pos: tok.pos }; }
          if (tok.value === 'pi') { return { type: 'num', value: Math.PI, pos: tok.pos }; }
          if (tok.value === 'e') { return { type: 'num', value: Math.E, pos: tok.pos }; }
          if (tok.value === 'nan') { return { type: 'num', value: NaN, pos: tok.pos }; }
          return fail('Unexpected ' + describe(tok), tok.pos);
        case 'ident': return parseCall(tok);
        case 'op':
          if (tok.value === '(') {
            var e = parseExpr();
            expectOp(')');
            e.paren = true;
            return e;
          }
          return fail('Unexpected ' + describe(tok), tok.pos);
        default: return fail('Unexpected ' + describe(tok), tok.pos);
      }
    }
    function parseCall(tok) {
      var name = tok.value.toLowerCase();
      if (!isOp(peek(), '(')) {
        fail("Unknown identifier '" + tok.value + "' -- channel names must be written in [brackets], e.g. [" + tok.value + "]", tok.pos);
      }
      var spec = FUNCTIONS[name];
      if (!spec) { fail("Unknown function '" + tok.value + "'", tok.pos); }
      next();                                                       // (
      var args = [];
      if (!isOp(peek(), ')')) {
        args.push(parseExpr());
        while (isOp(peek(), ',')) { next(); args.push(parseExpr()); }
      }
      expectOp(')');
      var canon = spec.alias || name, cs = FUNCTIONS[canon];
      if (args.length < cs.min || args.length > cs.max) {
        var want = cs.min === cs.max ? String(cs.min) : (cs.max === Infinity ? 'at least ' + cs.min : cs.min + '-' + cs.max);
        fail(name + '() expects ' + want + ' argument' + (cs.max === 1 ? '' : 's') + ' (' + name + '(' + cs.args + ')) but got ' + args.length, tok.pos);
      }
      return { type: 'call', name: name, fn: canon, args: args, pos: tok.pos };
    }

    var ast = parseExpr();
    if (peek().type !== 'eof') { fail('Unexpected ' + describe(peek()), peek().pos); }
    return ast;
  }

  function walk(node, visit) {
    visit(node);
    switch (node.type) {
      case 'neg': case 'not': walk(node.arg, visit); break;
      case 'and': case 'or': case 'bin': case 'cmp': walk(node.left, visit); walk(node.right, visit); break;
      case 'ternary': walk(node.cond, visit); walk(node.a, visit); walk(node.b, visit); break;
      case 'call': for (var i = 0; i < node.args.length; i++) { walk(node.args[i], visit); } break;
      default: break;
    }
  }

  function isBooleanNode(node) {
    switch (node.type) {
      case 'cmp': case 'and': case 'or': case 'not': return true;
      case 'num': return !!node.bool;
      case 'call':
        if (node.fn === 'held' || node.fn === 'isnan' || node.fn === 'isfinite') { return true; }
        if (node.fn === 'if') { return isBooleanNode(node.args[1]) && isBooleanNode(node.args[2]); }
        return false;
      case 'ternary': return isBooleanNode(node.a) && isBooleanNode(node.b);
      default: return false;
    }
  }

  function isConstantNode(node) {
    switch (node.type) {
      case 'num': return true;
      case 'neg': case 'not': return isConstantNode(node.arg);
      case 'and': case 'or': case 'bin': case 'cmp': return isConstantNode(node.left) && isConstantNode(node.right);
      case 'ternary': return isConstantNode(node.cond) && isConstantNode(node.a) && isConstantNode(node.b);
      case 'call':
        if (FUNCTIONS[node.fn].kind !== 'scalar') { return false; }
        for (var i = 0; i < node.args.length; i++) { if (!isConstantNode(node.args[i])) { return false; } }
        return true;
      default: return false;
    }
  }

  /** @returns {{ok:true, ast, references:string[], functions:string[]}|{ok:false, error:{message,pos}}} */
  function parse(src) {
    src = src == null ? '' : String(src);
    try {
      if (!src.replace(/^\s+|\s+$/g, '')) { fail('Empty expression', 0); }
      var ast = parseTokens(tokenize(src));
      var references = [], functions = [];
      walk(ast, function (node) {
        if (node.type === 'ref' && references.indexOf(node.name) < 0) { references.push(node.name); }
        if (node.type === 'call' && functions.indexOf(node.name) < 0) { functions.push(node.name); }
      });
      return { ok: true, ast: ast, references: references, functions: functions };
    } catch (e) {
      return { ok: false, error: errorFrom(e) };
    }
  }

  // ================================================================================================
  // 4. Compile context: channel resolution + shared window bounds
  // ================================================================================================
  function makeContext(ctx) {
    ctx = ctx || {};
    var time = ctx.time && ctx.time.length !== undefined ? ctx.time : null;
    var n = typeof ctx.n === 'number' && ctx.n >= 0 ? Math.floor(ctx.n) : (time ? time.length : 0);
    return { ctx: ctx, time: time, n: n, chans: {}, missing: [], bounds: {}, maxLen: 0,
      memoNodes: [], memoFns: [], timeOk: null, gapTol: null };
  }

  /** Resolve a channel once per compile; returns {values, levels, labelNum} (values null when missing). */
  function channel(cc, name) {
    if (Object.prototype.hasOwnProperty.call(cc.chans, name)) { return cc.chans[name]; }
    var rec = null;
    try { rec = typeof cc.ctx.resolve === 'function' ? cc.ctx.resolve(name) : null; } catch (e) { rec = null; }
    var ch;
    if (!rec || !rec.values || rec.values.length === undefined) {
      ch = { values: null, levels: null, labelNum: null };
      if (cc.missing.indexOf(name) < 0) { cc.missing.push(name); }
    } else {
      var levels = Array.isArray(rec.levels) ? rec.levels : null, labelNum = null;
      if (levels) {
        labelNum = new Float64Array(levels.length);
        for (var k = 0; k < levels.length; k++) { labelNum[k] = toNum(levels[k]); }
      }
      ch = { values: rec.values, levels: levels, labelNum: labelNum };
      if (rec.values.length > cc.maxLen) { cc.maxLen = rec.values.length; }
    }
    cc.chans[name] = ch;
    return ch;
  }

  /** Two-pointer inclusive window bounds for [t_i - back, t_i + fwd]; cached per (back,fwd). O(N). */
  function windowBounds(cc, back, fwd) {
    var key = back + '|' + fwd;
    if (cc.bounds[key]) { return cc.bounds[key]; }
    var t = cc.time, nW = Math.min(cc.n, t.length);
    var LO = new Int32Array(nW), HI = new Int32Array(nW), lo = 0, hi = 0;
    for (var i = 0; i < nW; i++) {
      var tmin = t[i] - back - EPS, tmax = t[i] + fwd + EPS;
      while (lo < i && t[lo] < tmin) { lo++; }
      if (hi < i) { hi = i; }
      while (hi + 1 < nW && t[hi + 1] <= tmax) { hi++; }
      LO[i] = lo; HI[i] = hi;
    }
    cc.bounds[key] = { lo: LO, hi: HI, nW: nW };
    return cc.bounds[key];
  }

  /** Window functions need a monotonic time axis (the two-pointer bounds would silently GROW on a
   *  decreasing or NaN timestamp). Scanned once per compile; a bad axis fails the window function's
   *  compile with ok:false, while non-window expressions on the same log still work. */
  function checkTimeAxis(cc, node) {
    if (cc.timeOk === null) {
      var t = cc.time, nW = Math.min(cc.n, t.length), okT = true, prev = -Infinity, v;
      for (var j = 0; j < nW; j++) {
        v = t[j];
        if (typeof v !== 'number' || v !== v || v === Infinity || v === -Infinity || v < prev) { okT = false; break; }
        prev = v;
      }
      cc.timeOk = okT;
    }
    if (!cc.timeOk) { fail('time axis is not ascending', node.pos); }
  }

  /** held() gap tolerance: 2 x the log's median sample period (median of a stride sample of at most
   *  65536 positive dts). A normally jittered log stays well inside it; a logging pause does not. */
  function gapTolerance(cc) {
    if (cc.gapTol !== null) { return cc.gapTol; }
    var t = cc.time, nW = Math.min(cc.n, t.length), stride = nW > 65536 ? Math.ceil(nW / 65536) : 1, ds = [], j, d;
    for (j = 1; j < nW; j += stride) { d = t[j] - t[j - 1]; if (d > 0) { ds.push(d); } }
    ds.sort(function (a, b) { return a - b; });
    cc.gapTol = ds.length ? 2 * ds[ds.length >> 1] : 0;
    return cc.gapTol;
  }

  /** Largest gap between consecutive samples INSIDE each window (over j in (lo, hi]); monotonic deque, O(N). */
  function slidingMaxGap(t, LO, HI, nW) {
    var out = new Float64Array(nW), dq = new Int32Array(nW || 1), head = 0, tail = 0, hi = 0, i, d;
    for (i = 0; i < nW; i++) {
      var L = LO[i], H = HI[i];
      while (hi < H) {
        hi++; d = t[hi] - t[hi - 1];
        while (tail > head && t[dq[tail - 1]] - t[dq[tail - 1] - 1] <= d) { tail--; }
        dq[tail++] = hi;
      }
      while (head < tail && dq[head] <= L) { head++; }
      out[i] = head < tail ? t[dq[head]] - t[dq[head] - 1] : 0;
    }
    return out;
  }

  // ================================================================================================
  // 5. Window algorithms (all O(N); NaN inputs skipped)
  // ================================================================================================
  /** avg/sum/slope via sliding sums that are re-summed from scratch (with the time origin moved to
   *  the window start) every time the window has fully turned over -> amortized O(N) and no
   *  precision loss from giant prefix sums late in a long log. */
  function slidingStats(kind, x, t, LO, HI, out, nW) {
    var lo = 0, hi = -1, cnt = 0, sx = 0, st = 0, stt = 0, stx = 0, tc = 0, lastSync = -1, syncLen = 0;
    var needT = kind === 'slope', i, j, v, tt;
    for (i = 0; i < nW; i++) {
      var L = LO[i], H = HI[i];
      if (i - lastSync >= syncLen || L > hi) {
        tc = t[L]; cnt = 0; sx = 0; st = 0; stt = 0; stx = 0;
        for (j = L; j <= H; j++) {
          v = x[j];
          if (v === v && v !== Infinity && v !== -Infinity) {
            cnt++; sx += v;
            if (needT) { tt = t[j] - tc; st += tt; stt += tt * tt; stx += tt * v; }
          }
        }
        lo = L; hi = H; lastSync = i; syncLen = H - L + 1;
      } else {
        while (lo < L) {
          v = x[lo];
          if (v === v && v !== Infinity && v !== -Infinity) {
            cnt--; sx -= v;
            if (needT) { tt = t[lo] - tc; st -= tt; stt -= tt * tt; stx -= tt * v; }
          }
          lo++;
        }
        while (hi < H) {
          hi++; v = x[hi];
          if (v === v && v !== Infinity && v !== -Infinity) {
            cnt++; sx += v;
            if (needT) { tt = t[hi] - tc; st += tt; stt += tt * tt; stx += tt * v; }
          }
        }
      }
      if (kind === 'sum') { out[i] = cnt ? sx : NaN; }
      else if (kind === 'avg') { out[i] = cnt ? sx / cnt : NaN; }
      else if (cnt < 2) { out[i] = NaN; }
      else {
        var den = cnt * stt - st * st;
        out[i] = den > cnt * stt * 1e-12 ? (cnt * stx - st * sx) / den : NaN;
      }
    }
  }

  /** minw/maxw via a monotonic deque over the (monotonically advancing) window. */
  function slidingExtreme(isMin, x, LO, HI, out, nW) {
    var dq = new Int32Array(nW || 1), head = 0, tail = 0, hi = -1, i, v;
    for (i = 0; i < nW; i++) {
      var L = LO[i], H = HI[i];
      while (hi < H) {
        hi++; v = x[hi];
        if (v === v && v !== Infinity && v !== -Infinity) {
          if (isMin) { while (tail > head && x[dq[tail - 1]] >= v) { tail--; } }
          else { while (tail > head && x[dq[tail - 1]] <= v) { tail--; } }
          dq[tail++] = hi;
        }
      }
      while (head < tail && dq[head] < L) { head++; }
      out[i] = head < tail ? x[dq[head]] : NaN;
    }
  }

  function slidingDelta(x, LO, HI, out, nW) {
    var nf = new Int32Array(nW || 1), pf = new Int32Array(nW || 1), i, last = -1;
    for (i = nW - 1; i >= 0; i--) { if (isFin(x[i])) { last = i; } nf[i] = last; }
    last = -1;
    for (i = 0; i < nW; i++) { if (isFin(x[i])) { last = i; } pf[i] = last; }
    for (i = 0; i < nW; i++) {
      var first = nf[LO[i]], fin = pf[HI[i]];
      out[i] = (first >= 0 && first <= HI[i]) ? x[fin] - x[first] : NaN;
    }
  }

  function computeWindow(fn, arg, back, fwd, cc) {
    var n = cc.n, t = cc.time, b = windowBounds(cc, back, fwd), nW = b.nW, LO = b.lo, HI = b.hi;
    var out = new Float64Array(n), i, v;
    for (i = nW; i < n; i++) { out[i] = NaN; }
    if (fn === 'held' || fn === 'count') {
      var pre = new Int32Array(nW + 1);
      for (i = 0; i < nW; i++) { v = arg(i); pre[i + 1] = pre[i] + ((v === v && v !== 0) ? 1 : 0); }
      if (fn === 'count') {
        for (i = 0; i < nW; i++) { out[i] = pre[HI[i] + 1] - pre[LO[i]]; }
      } else {
        // held(): cond true at every window sample AND the window is (a) inside the log and (b) COVERED
        // by samples: every sample interval that overlaps [ws, we] is at most G long -- the interval
        // straddling the window start (t[lo-1], t[lo]] unless a sample sits on ws, the intervals inside
        // the window, and the one straddling the end. A lone sample after a logging pause (0 ms of
        // history) therefore yields 0; a window shorter than the local spacing reduces to cond at i.
        var t0 = nW ? t[0] - EPS : 0, tn = nW ? t[nW - 1] + EPS : 0;
        var G = gapTolerance(cc) + EPS, maxGap = (back > 0 || fwd > 0) ? slidingMaxGap(t, LO, HI, nW) : null;
        for (i = 0; i < nW; i++) {
          var lo = LO[i], hi = HI[i], ws = t[i] - back, we = t[i] + fwd;
          out[i] = (pre[hi + 1] - pre[lo] === hi - lo + 1 && ws >= t0 && we <= tn &&
            (t[lo] - ws <= EPS || (lo > 0 && t[lo] - t[lo - 1] <= G)) &&
            (we - t[hi] <= EPS || (hi + 1 < nW && t[hi + 1] - t[hi] <= G)) &&
            (maxGap === null || maxGap[i] <= G)) ? 1 : 0;
        }
      }
      return out;
    }
    var x = new Float64Array(nW);
    for (i = 0; i < nW; i++) { x[i] = arg(i); }
    if (fn === 'avg' || fn === 'sum' || fn === 'slope') { slidingStats(fn, x, t, LO, HI, out, nW); }
    else if (fn === 'minw' || fn === 'maxw') { slidingExtreme(fn === 'minw', x, LO, HI, out, nW); }
    else if (fn === 'delta') { slidingDelta(x, LO, HI, out, nW); }
    return out;
  }

  // ================================================================================================
  // 6. AST -> closure tree. Every closure is function(i) -> number (NaN for missing/out of range).
  // ================================================================================================
  /** Memoized per AST node: a node shared by two parents (the middle operand of `a < b < c`) is
   *  compiled once, so a window function inside it is also COMPUTED once. */
  function build(node, cc) {
    var k = cc.memoNodes.indexOf(node);
    if (k >= 0) { return cc.memoFns[k]; }
    var fn = buildNode(node, cc);
    cc.memoNodes.push(node); cc.memoFns.push(fn);
    return fn;
  }
  function buildNode(node, cc) {
    switch (node.type) {
      case 'num': return constFn(node.value);
      case 'str': return fail('String literals may only be used in comparisons (e.g. [Gear] == \'4\')', node.pos);
      case 'ref': return buildRef(node, cc);
      case 'neg': return (function (a) { return function (i) { return finiteOrNaN(-a(i)); }; })(build(node.arg, cc));
      case 'not': return (function (a) { return function (i) { var v = a(i); return (v === v && v !== 0) ? 0 : 1; }; })(build(node.arg, cc));
      case 'and': return (function (l, r) {
        return function (i) { var a = l(i); if (a !== a || a === 0) { return 0; } var b = r(i); return (b !== b || b === 0) ? 0 : 1; };
      })(build(node.left, cc), build(node.right, cc));
      case 'or': return (function (l, r) {
        return function (i) { var a = l(i); if (a === a && a !== 0) { return 1; } var b = r(i); return (b === b && b !== 0) ? 1 : 0; };
      })(build(node.left, cc), build(node.right, cc));
      case 'bin': return buildBin(node, cc);
      case 'cmp': return buildCmp(node, cc);
      case 'ternary': return (function (c, a, b) {
        return function (i) { var v = c(i); return (v === v && v !== 0) ? a(i) : b(i); };
      })(build(node.cond, cc), build(node.a, cc), build(node.b, cc));
      case 'call': return buildCall(node, cc);
      default: return fail('Internal error: unknown node type ' + node.type, node.pos || 0);
    }
  }

  function buildRef(node, cc) {
    var ch = channel(cc, node.name);
    if (!ch.values) { return constFn(NaN); }
    var vals = ch.values;
    if (ch.levels) {                                                 // categorical -> Number(label)
      var ln = ch.labelNum;
      return function (i) { var r = ln[vals[i]]; return r === undefined ? NaN : r; };
    }
    return function (i) { var v = vals[i]; return (typeof v === 'number' && v !== Infinity && v !== -Infinity) ? v : NaN; };
  }

  function buildBin(node, cc) {
    var l = build(node.left, cc), r = build(node.right, cc);
    switch (node.op) {
      case '+': return function (i) { return finiteOrNaN(l(i) + r(i)); };
      case '-': return function (i) { return finiteOrNaN(l(i) - r(i)); };
      case '*': return function (i) { return finiteOrNaN(l(i) * r(i)); };
      case '/': return function (i) { var d = r(i); return d === 0 ? NaN : finiteOrNaN(l(i) / d); };
      case '%': return function (i) { var d = r(i); return d === 0 ? NaN : l(i) % d; };
      case '^': return function (i) { return finiteOrNaN(Math.pow(l(i), r(i))); };
      default: return fail('Internal error: unknown operator ' + node.op, node.pos);
    }
  }

  var FLIP = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '!=': '!=' };

  function cmpFn(op, l, r) {
    switch (op) {
      case '<': return function (i) { return l(i) < r(i) ? 1 : 0; };
      case '<=': return function (i) { return l(i) <= r(i) ? 1 : 0; };
      case '>': return function (i) { return l(i) > r(i) ? 1 : 0; };
      case '>=': return function (i) { return l(i) >= r(i) ? 1 : 0; };
      case '==': return function (i) { return l(i) === r(i) ? 1 : 0; };
      default: return function (i) { var a = l(i), b = r(i); return (a === a && b === b && a !== b) ? 1 : 0; };
    }
  }
  /** Same as cmpFn with a constant right side (the hot path for filters). NaN compares false. */
  function cmpConstFn(op, l, c) {
    switch (op) {
      case '<': return function (i) { return l(i) < c ? 1 : 0; };
      case '<=': return function (i) { return l(i) <= c ? 1 : 0; };
      case '>': return function (i) { return l(i) > c ? 1 : 0; };
      case '>=': return function (i) { return l(i) >= c ? 1 : 0; };
      case '==': return function (i) { return l(i) === c ? 1 : 0; };
      default: return function (i) { var a = l(i); return (a === a && a !== c) ? 1 : 0; };
    }
  }

  function catChannel(node, cc) {
    if (node.type !== 'ref') { return null; }
    var ch = channel(cc, node.name);
    return ch.levels ? ch : null;
  }

  /** Categorical channel ==/!= literal, string OR numeric spelling: ONE path. `match` is a per-level
   *  table (1 = the level's label matches the literal). A sample without a label (NaN, out-of-range
   *  index) is 0 for BOTH operators; a literal matching no level makes `==` always 0 and `!=` 1 for
   *  every labelled sample. */
  function catMatchFn(ch, match, neq) {
    var vals = ch.values;
    if (neq) { return function (i) { var m = match[vals[i]]; return m === undefined ? 0 : (m ? 0 : 1); }; }
    return function (i) { return match[vals[i]] ? 1 : 0; };
  }
  function catMatchString(ch, literal) {
    var levels = ch.levels, match = new Uint8Array(levels.length), idx = levels.indexOf(literal), k, tl;
    if (idx < 0) {
      tl = literal.replace(/^\s+|\s+$/g, '');
      for (k = 0; k < levels.length; k++) { if (String(levels[k]).replace(/^\s+|\s+$/g, '') === tl) { idx = k; break; } }
    }
    if (idx >= 0) { match[idx] = 1; }
    return match;
  }
  function catMatchNumber(ch, num) {                                 // Number(label) === num; 'No' never matches
    var ln = ch.labelNum, match = new Uint8Array(ln.length);
    for (var k = 0; k < ln.length; k++) { if (ln[k] === num) { match[k] = 1; } }
    return match;
  }

  function buildCmp(node, cc) {
    var L = node.left, R = node.right, op = node.op;
    if (L.type === 'str' && R.type === 'str') { fail('Cannot compare two string literals', node.pos); }
    if (L.type === 'str') { return buildCmpWithString(R, L.value, FLIP[op], cc); }
    if (R.type === 'str') { return buildCmpWithString(L, R.value, op, cc); }
    var cl = catChannel(L, cc), cr = catChannel(R, cc);
    if (cl && cr && (op === '==' || op === '!=')) {                 // categorical vs categorical: label text
      var lv = cl.values, ll = cl.levels, rv = cr.values, rl = cr.levels, neq = op === '!=';
      return function (i) {
        var a = ll[lv[i]], b = rl[rv[i]];
        if (a === undefined || b === undefined) { return 0; }
        return (a === b) !== neq ? 1 : 0;
      };
    }
    if ((op === '==' || op === '!=') && ((cl && isConstantNode(R)) || (cr && isConstantNode(L)))) {
      var cch = cl || cr, cval = build(cl ? R : L, cc)(0);            // categorical vs numeric constant: label match
      if (!isFin(cval)) { return constFn(0); }
      return catMatchFn(cch, catMatchNumber(cch, cval), op === '!=');
    }
    var l = build(L, cc);
    if (R.type === 'num') { return cmpConstFn(op, l, R.value); }
    return cmpFn(op, l, build(R, cc));
  }

  /** expr OP 'literal' -- categorical: label match; numeric: Number(literal) (non-numeric -> false). */
  function buildCmpWithString(exprNode, literal, op, cc) {
    var ch = catChannel(exprNode, cc);
    if (ch && (op === '==' || op === '!=')) { return catMatchFn(ch, catMatchString(ch, literal), op === '!='); }
    var num = toNum(literal);
    if (num !== num) { return constFn(0); }
    return cmpConstFn(op, build(exprNode, cc), num);
  }

  function constValue(node, cc, what) {
    if (!isConstantNode(node)) { fail(what + ' must be a constant number', node.pos); }
    var v = build(node, cc)(0);
    if (!isFin(v)) { fail(what + ' must be a finite number', node.pos); }
    return v;
  }

  function requireTime(cc, node) {
    if (!cc.time) { fail(node.name + '() needs the log time array (ctx.time)', node.pos); }
  }

  function buildCall(node, cc) {
    var fn = node.fn, args = node.args, fs = [], k;
    if (TIME_FUNCTIONS[fn]) { requireTime(cc, node); }
    if (fn === 'dt') { return function (i) { var t = cc.time; return (i > 0 && i < cc.n && i < t.length) ? t[i] - t[i - 1] : NaN; }; }
    if (fn === 't') { return function (i) { var v = cc.time[i]; return (typeof v === 'number' && i < cc.n) ? v : NaN; }; }
    if (fn === 'prev' || fn === 'next') {
      var shift = Math.round(constValue(args[1], cc, fn + '() sample count'));
      if (fn === 'next') { shift = -shift; }
      var src = build(args[0], cc);
      return function (i) { var j = i - shift; return (j < 0 || j >= cc.n) ? NaN : src(j); };
    }
    if (FUNCTIONS[fn].kind === 'window') {
      checkTimeAxis(cc, node);
      var back = constValue(args[1], cc, 'Window size (backMs)') / 1000;
      var fwd = args.length > 2 ? constValue(args[2], cc, 'Window size (fwdMs)') / 1000 : 0;
      if (back < 0 || fwd < 0) { fail('Window sizes must be >= 0 ms', node.pos); }
      var arg = build(args[0], cc), cache = null;
      return function (i) {
        if (!cache) { cache = computeWindow(fn, arg, back, fwd, cc); }
        var v = cache[i];
        return v === undefined ? NaN : finiteOrNaN(v);
      };
    }
    for (k = 0; k < args.length; k++) { fs.push(build(args[k], cc)); }
    var a = fs[0], b = fs[1], c = fs[2];
    switch (fn) {
      case 'abs': return function (i) { return finiteOrNaN(Math.abs(a(i))); };
      case 'min': return function (i) { var m = a(i); for (var k2 = 1; k2 < fs.length; k2++) { var v = fs[k2](i); if (v !== v) { return NaN; } if (v < m) { m = v; } } return m; };
      case 'max': return function (i) { var m = a(i); for (var k2 = 1; k2 < fs.length; k2++) { var v = fs[k2](i); if (v !== v) { return NaN; } if (v > m) { m = v; } } return m; };
      case 'floor': return function (i) { return Math.floor(a(i)); };
      case 'ceil': return function (i) { return Math.ceil(a(i)); };
      case 'round': return function (i) { return Math.round(a(i)); };
      case 'sqrt': return function (i) { return Math.sqrt(a(i)); };
      case 'exp': return function (i) { return finiteOrNaN(Math.exp(a(i))); };
      case 'log': return function (i) { var v = a(i); return v > 0 ? Math.log(v) : NaN; };
      case 'log10': return function (i) { var v = a(i); return v > 0 ? log10(v) : NaN; };
      case 'pow': return function (i) { return finiteOrNaN(Math.pow(a(i), b(i))); };
      case 'clamp': return function (i) { var v = a(i), lo = b(i), hi = c(i); return v < lo ? lo : (v > hi ? hi : v); };
      case 'if': return function (i) { var v = a(i); return (v === v && v !== 0) ? b(i) : c(i); };
      case 'isnan': return function (i) { var v = a(i); return v !== v ? 1 : 0; };
      case 'isfinite': return function (i) { return isFin(a(i)) ? 1 : 0; };
      case 'sign': return function (i) { var v = a(i); return v > 0 ? 1 : (v < 0 ? -1 : (v === 0 ? 0 : NaN)); };
      default: return fail('Internal error: unhandled function ' + fn, node.pos);
    }
  }

  // ================================================================================================
  // 7. compile()
  // ================================================================================================
  /**
   * @param {string} src
   * @param {{resolve:function(string):({values:number[],levels:?string[],unit:?string}|null), time:number[], n:number}} ctx
   * @returns {{ok:boolean, error:?{message:string,pos:number}, references:string[], missing:string[],
   *            isBoolean:boolean, evaluateAt:function(number):number,
   *            evaluateAll:function(number=,number=):Float64Array, evaluateMask:function(number=,number=):Uint8Array}}
   * Never throws. If missing.length, ok is still true but every evaluation yields NaN / 0 -- the
   * caller decides. Window structures are computed lazily on first evaluation and cached.
   */
  function compile(src, ctx) {
    var res = {
      ok: false, error: null, references: [], missing: [], functions: [], isBoolean: false, ast: null,
      evaluateAt: function () { return NaN; },
      evaluateAll: function () { return new Float64Array(0); },
      evaluateMask: function () { return new Uint8Array(0); }
    };
    var parsed = parse(src);
    if (!parsed.ok) { res.error = parsed.error; return res; }
    res.ast = parsed.ast; res.references = parsed.references; res.functions = parsed.functions;
    res.isBoolean = isBooleanNode(parsed.ast);
    var cc = makeContext(ctx), root;
    try { root = build(parsed.ast, cc); } catch (e) { res.error = errorFrom(e); return res; }
    if (!cc.n) { cc.n = cc.maxLen; }
    res.ok = true;
    res.missing = cc.missing;
    var hasMissing = cc.missing.length > 0;

    function range(s, e) {
      var n = cc.n;
      s = (s == null || s !== s) ? 0 : Math.max(0, Math.floor(s));
      e = (e == null || e !== e) ? n - 1 : Math.min(n - 1, Math.floor(e));
      return { s: s, e: e, len: Math.max(0, e - s + 1) };
    }
    res.evaluateAt = function (i) {
      if (hasMissing) { return NaN; }
      return root(i);
    };
    res.evaluateAll = function (startIdx, endIdx) {
      var r = range(startIdx, endIdx), out = new Float64Array(r.len), i, k;
      if (hasMissing) { for (k = 0; k < r.len; k++) { out[k] = NaN; } return out; }
      for (i = r.s, k = 0; i <= r.e; i++, k++) { out[k] = root(i); }
      return out;
    };
    res.evaluateMask = function (startIdx, endIdx) {
      var r = range(startIdx, endIdx), out = new Uint8Array(r.len), i, k, v;
      if (hasMissing) { return out; }
      for (i = r.s, k = 0; i <= r.e; i++, k++) { v = root(i); out[k] = (v === v && v !== 0) ? 1 : 0; }
      return out;
    };
    return res;
  }

  // ================================================================================================
  // 8. Simple-filter builder (GUI rows <-> source text)
  //    clauses: [{ param, op:'>'|'>='|'<'|'<='|'=='|'!='|'=', value:number|string, join:'AND'|'OR' }, ...]
  //    A nested plain array is a parenthesized group joined with AND; { group:[...], join } carries
  //    an explicit join (parseSimpleFilter always emits the object form so a group can be OR-joined).
  //    join applies BETWEEN clause k-1 and k and is ignored on the first clause.
  // ================================================================================================
  /** [Name] normally; "Name" when the name contains ']'. A name with BOTH ']' and '"' cannot be
   *  referenced at all, and is rejected (thrown) rather than silently rewritten. */
  function refText(name) {
    name = String(name).replace(/^\s+|\s+$/g, '');
    var hasClose = name.indexOf(']') >= 0, hasQuote = name.indexOf('"') >= 0;
    if (hasClose && hasQuote) { throw new Error('Channel name cannot be referenced in a filter because it contains both "]" and a double quote: ' + name); }
    return hasClose ? '"' + name + '"' : '[' + name + ']';
  }
  function valueText(v) {
    if (typeof v === 'number') { return isFin(v) ? String(v) : 'nan'; }
    if (typeof v === 'boolean') { return v ? '1' : '0'; }
    if (v == null) { return 'nan'; }
    return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  }
  function opText(op) {
    op = String(op == null ? '==' : op).replace(/^\s+|\s+$/g, '');
    return op === '=' ? '==' : op;
  }

  /** Rows read TOP TO BOTTOM: [A, B(or), C(and)] means (A or B) and C, so whenever the join changes
   *  everything built so far is parenthesised as one operand ("([A] > 1 or [B] > 1) and [C] > 1").
   *  Throws (from refText) for a channel name that cannot be referenced. */
  function buildSimpleFilter(clauses) {
    if (!Array.isArray(clauses)) { return ''; }
    var text = '', prevJoin = null;
    for (var k = 0; k < clauses.length; k++) {
      var c = clauses[k], part, join;
      if (Array.isArray(c)) { part = '(' + buildSimpleFilter(c) + ')'; join = 'AND'; }
      else if (c && Array.isArray(c.group)) { part = '(' + buildSimpleFilter(c.group) + ')'; join = c.join; }
      else if (c) { part = refText(c.param) + ' ' + opText(c.op) + ' ' + valueText(c.value); join = c.join; }
      else { continue; }
      if (!text) { text = part; continue; }
      join = String(join || 'AND').toUpperCase() === 'OR' ? 'or' : 'and';
      if (prevJoin !== null && prevJoin !== join) { text = '(' + text + ')'; }
      text += ' ' + join + ' ' + part;
      prevJoin = join;
    }
    return text;
  }

  /** Best-effort inverse of buildSimpleFilter; null when the expression uses anything else. */
  function parseSimpleFilter(src) {
    var p = parse(src);
    if (!p.ok) { return null; }
    var out = [];
    try { flattenFilter(p.ast, out, 'AND', true); } catch (e) { return null; }
    return out;
  }
  function literalValue(node) {
    if (node.type === 'str') { return node.value; }
    if (node.type === 'num' && isFin(node.value)) { return node.value; }
    if (node.type === 'neg' && node.arg.type === 'num' && isFin(node.arg.value)) { return -node.arg.value; }
    return fail('not a simple literal', node.pos);
  }
  function isLiteralNode(node) {
    return node.type === 'str' || node.type === 'num' || (node.type === 'neg' && node.arg.type === 'num');
  }
  /** Rows must read in evaluation order. A logic node in the LEFT position of its parent is inlined
   *  whether or not it is parenthesised (`(A or B) and C` and `A and B or C` both read row by row);
   *  a logic node in the RIGHT position -- `A or (B and C)`, or `A or B and C` where `and` binds
   *  first -- becomes a {group} row, because inlining it would read as (A or B) and C. */
  function flattenFilter(node, out, join, inline) {
    var isLogic = node.type === 'and' || node.type === 'or';
    if (isLogic && inline) {
      flattenFilter(node.left, out, join, true);
      flattenFilter(node.right, out, node.type.toUpperCase(), false);
      return;
    }
    if (isLogic) {
      var grp = [];
      flattenFilter(node, grp, 'AND', true);
      out.push({ group: grp, join: join });
      return;
    }
    if (node.type !== 'cmp') { fail('not a simple comparison', node.pos); }
    var L = node.left, R = node.right;
    if (L.type === 'ref' && isLiteralNode(R)) { out.push({ param: L.name, op: node.op, value: literalValue(R), join: join }); }
    else if (isLiteralNode(L) && R.type === 'ref') { out.push({ param: R.name, op: FLIP[node.op], value: literalValue(L), join: join }); }
    else { fail('not a simple comparison', node.pos); }
  }

  // ================================================================================================
  // 9. Public API namespace (consumed by the viewer's Histograms view + dev/expr-test.js)
  // ================================================================================================
  // ================================================================================================
  // 8b. Forgiving channel lookup + auto-bracketing (Ken, 2026-09-08: a stray space in a formula
  //     made "[Long Term Fuel Trim 1]" fail to resolve and the editor refused to save the term)
  // ================================================================================================
  /** Case-, underscore- and whitespace-insensitive key: "Long  Term_Fuel Trim 1 " -> "long term fuel trim 1". */
  function normName(s) { return String(s == null ? '' : s).toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim(); }

  /**
   * seriesResolver(series, levels, fallback) -> resolve(name)
   * The `resolve` a compile ctx wants, built over a {name: values} map: exact name first, then the
   * normalised name (so a double space, different case or trailing blank still hits), then
   * `fallback(name)` (e.g. a named math channel) when nothing in the log matches.
   */
  function seriesResolver(series, levels, fallback) {
    series = series || {}; levels = levels || {};
    var byNorm = null;
    function loose(name) {
      if (!byNorm) {
        byNorm = {};
        for (var k in series) { if (Object.prototype.hasOwnProperty.call(series, k)) { var nk = normName(k); if (byNorm[nk] === undefined) byNorm[nk] = k; } }
      }
      var hit = byNorm[normName(name)];
      return hit === undefined ? null : hit;
    }
    var resolve = function (name) {
      var key = Object.prototype.hasOwnProperty.call(series, name) && series[name] ? name : loose(name);
      if (key && series[key]) { return { values: series[key], levels: levels[key] || null }; }
      return typeof fallback === 'function' ? fallback(name) : null;
    };
    resolve.channelFor = function (name) { return Object.prototype.hasOwnProperty.call(series, name) && series[name] ? name : loose(name); };
    return resolve;
  }

  /**
   * autoBracket(src, names) -> { src, changed:[{from,to}] }
   * A channel name typed WITHOUT brackets ("Short Term Fuel Trim 1 + Long Term Fuel Trim 1") is a
   * parse error, because a name with spaces is several identifiers. Rewrites every maximal run of
   * bare words/numbers that spells a known name (case/space-insensitively) as [Name], leaving
   * existing [..] / ".." references, string literals, numbers, operators and function names alone.
   * Never throws; a source it cannot improve comes back unchanged.
   */
  function autoBracket(src, names) {
    src = String(src == null ? '' : src);
    var out = { src: src, changed: [] };
    if (!Array.isArray(names) || !names.length) { return out; }
    var byNorm = {}, maxWords = 1;
    names.forEach(function (n) {
      var k = normName(n);
      if (!k || byNorm[k] !== undefined) { return; }
      byNorm[k] = n;
      var w = k.split(' ').length;
      if (w > maxWords) { maxWords = w; }
    });
    // Split into protected spans ([..], "..", '..') and free text.
    var parts = [], i = 0, n = src.length, buf = '';
    while (i < n) {
      var ch = src.charAt(i), close = ch === '[' ? ']' : ch === '"' ? '"' : ch === "'" ? "'" : null;
      if (close) {
        var end = src.indexOf(close, i + 1);
        if (end < 0) { end = n - 1; }
        if (buf) { parts.push({ free: true, text: buf }); buf = ''; }
        parts.push({ free: false, text: src.slice(i, end + 1) });
        i = end + 1; continue;
      }
      buf += ch; i++;
    }
    if (buf) { parts.push({ free: true, text: buf }); }
    var WORD = /[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?/g;
    parts.forEach(function (p) {
      if (!p.free) { return; }
      var words = [], m;
      WORD.lastIndex = 0;
      while ((m = WORD.exec(p.text))) { words.push({ text: m[0], start: m.index, end: m.index + m[0].length }); }
      if (!words.length) { return; }
      // Greedy longest-match over word runs joined by single spaces (only whitespace may sit between).
      var res = '', pos = 0, w = 0;
      while (w < words.length) {
        var best = null;
        for (var len = Math.min(maxWords, words.length - w); len >= 1; len--) {
          var contiguous = true;
          for (var q = w; q < w + len - 1; q++) { if (!/^\s+$/.test(p.text.slice(words[q].end, words[q + 1].start))) { contiguous = false; break; } }
          if (!contiguous) { continue; }
          var key = normName(p.text.slice(words[w].start, words[w + len - 1].end));
          if (byNorm[key] !== undefined) { best = { len: len, name: byNorm[key] }; break; }
        }
        if (best) {
          var from = p.text.slice(words[w].start, words[w + best.len - 1].end);
          res += p.text.slice(pos, words[w].start) + '[' + best.name + ']';
          out.changed.push({ from: from, to: '[' + best.name + ']' });
          pos = words[w + best.len - 1].end;
          w += best.len;
        } else { w++; }
      }
      res += p.text.slice(pos);
      p.text = res;
    });
    if (out.changed.length) { out.src = parts.map(function (p) { return p.text; }).join(''); }
    return out;
  }

  var DatalogExpr = {
    VERSION: VERSION,
    parse: parse,
    compile: compile,
    buildSimpleFilter: buildSimpleFilter,
    parseSimpleFilter: parseSimpleFilter,
    listFunctions: listFunctions,
    normName: normName,
    seriesResolver: seriesResolver,
    autoBracket: autoBracket
  };
  global.DatalogExpr = DatalogExpr;
})(typeof window !== 'undefined' ? window : globalThis);
