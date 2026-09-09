(() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e) {
      throw mod = 0, e;
    }
  };
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));

  // ../../../../websites/Alldatalogs/apps/web/public/vendor/pako.min.js
  var require_pako_min = __commonJS({
    "../../../../websites/Alldatalogs/apps/web/public/vendor/pako.min.js"(exports, module) {
      "use strict";
      !(function(t, e) {
        "object" == typeof exports && "undefined" != typeof module ? e(exports) : "function" == typeof define && define.amd ? define(["exports"], e) : e((t = "undefined" != typeof globalThis ? globalThis : t || self).pako = {});
      })(exports, (function(t) {
        "use strict";
        function e(t2) {
          let e2 = t2.length;
          for (; --e2 >= 0; ) t2[e2] = 0;
        }
        const a = 256, i = 286, n = 30, s = 15, r = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]), o = new Uint8Array([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]), l = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7]), h = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]), d = new Array(576);
        e(d);
        const _ = new Array(60);
        e(_);
        const f = new Array(512);
        e(f);
        const c = new Array(256);
        e(c);
        const u = new Array(29);
        e(u);
        const w = new Array(n);
        function m(t2, e2, a2, i2, n2) {
          this.static_tree = t2, this.extra_bits = e2, this.extra_base = a2, this.elems = i2, this.max_length = n2, this.has_stree = t2 && t2.length;
        }
        let b, g, p;
        function k(t2, e2) {
          this.dyn_tree = t2, this.max_code = 0, this.stat_desc = e2;
        }
        e(w);
        const v = (t2) => t2 < 256 ? f[t2] : f[256 + (t2 >>> 7)], y = (t2, e2) => {
          t2.pending_buf[t2.pending++] = 255 & e2, t2.pending_buf[t2.pending++] = e2 >>> 8 & 255;
        }, x = (t2, e2, a2) => {
          t2.bi_valid > 16 - a2 ? (t2.bi_buf |= e2 << t2.bi_valid & 65535, y(t2, t2.bi_buf), t2.bi_buf = e2 >> 16 - t2.bi_valid, t2.bi_valid += a2 - 16) : (t2.bi_buf |= e2 << t2.bi_valid & 65535, t2.bi_valid += a2);
        }, z = (t2, e2, a2) => {
          x(t2, a2[2 * e2], a2[2 * e2 + 1]);
        }, A = (t2, e2) => {
          let a2 = 0;
          do {
            a2 |= 1 & t2, t2 >>>= 1, a2 <<= 1;
          } while (--e2 > 0);
          return a2 >>> 1;
        }, E = (t2, e2, a2) => {
          const i2 = new Array(16);
          let n2, r2, o2 = 0;
          for (n2 = 1; n2 <= s; n2++) o2 = o2 + a2[n2 - 1] << 1, i2[n2] = o2;
          for (r2 = 0; r2 <= e2; r2++) {
            let e3 = t2[2 * r2 + 1];
            0 !== e3 && (t2[2 * r2] = A(i2[e3]++, e3));
          }
        }, R = (t2) => {
          let e2;
          for (e2 = 0; e2 < i; e2++) t2.dyn_ltree[2 * e2] = 0;
          for (e2 = 0; e2 < n; e2++) t2.dyn_dtree[2 * e2] = 0;
          for (e2 = 0; e2 < 19; e2++) t2.bl_tree[2 * e2] = 0;
          t2.dyn_ltree[512] = 1, t2.opt_len = t2.static_len = 0, t2.sym_next = t2.matches = 0;
        }, Z = (t2) => {
          t2.bi_valid > 8 ? y(t2, t2.bi_buf) : t2.bi_valid > 0 && (t2.pending_buf[t2.pending++] = t2.bi_buf), t2.bi_buf = 0, t2.bi_valid = 0;
        }, U = (t2, e2, a2, i2) => {
          const n2 = 2 * e2, s2 = 2 * a2;
          return t2[n2] < t2[s2] || t2[n2] === t2[s2] && i2[e2] <= i2[a2];
        }, S = (t2, e2, a2) => {
          const i2 = t2.heap[a2];
          let n2 = a2 << 1;
          for (; n2 <= t2.heap_len && (n2 < t2.heap_len && U(e2, t2.heap[n2 + 1], t2.heap[n2], t2.depth) && n2++, !U(e2, i2, t2.heap[n2], t2.depth)); ) t2.heap[a2] = t2.heap[n2], a2 = n2, n2 <<= 1;
          t2.heap[a2] = i2;
        }, D = (t2, e2, i2) => {
          let n2, s2, l2, h2, d2 = 0;
          if (0 !== t2.sym_next) do {
            n2 = 255 & t2.pending_buf[t2.sym_buf + d2++], n2 += (255 & t2.pending_buf[t2.sym_buf + d2++]) << 8, s2 = t2.pending_buf[t2.sym_buf + d2++], 0 === n2 ? z(t2, s2, e2) : (l2 = c[s2], z(t2, l2 + a + 1, e2), h2 = r[l2], 0 !== h2 && (s2 -= u[l2], x(t2, s2, h2)), n2--, l2 = v(n2), z(t2, l2, i2), h2 = o[l2], 0 !== h2 && (n2 -= w[l2], x(t2, n2, h2)));
          } while (d2 < t2.sym_next);
          z(t2, 256, e2);
        }, T = (t2, e2) => {
          const a2 = e2.dyn_tree, i2 = e2.stat_desc.static_tree, n2 = e2.stat_desc.has_stree, r2 = e2.stat_desc.elems;
          let o2, l2, h2, d2 = -1;
          for (t2.heap_len = 0, t2.heap_max = 573, o2 = 0; o2 < r2; o2++) 0 !== a2[2 * o2] ? (t2.heap[++t2.heap_len] = d2 = o2, t2.depth[o2] = 0) : a2[2 * o2 + 1] = 0;
          for (; t2.heap_len < 2; ) h2 = t2.heap[++t2.heap_len] = d2 < 2 ? ++d2 : 0, a2[2 * h2] = 1, t2.depth[h2] = 0, t2.opt_len--, n2 && (t2.static_len -= i2[2 * h2 + 1]);
          for (e2.max_code = d2, o2 = t2.heap_len >> 1; o2 >= 1; o2--) S(t2, a2, o2);
          h2 = r2;
          do {
            o2 = t2.heap[1], t2.heap[1] = t2.heap[t2.heap_len--], S(t2, a2, 1), l2 = t2.heap[1], t2.heap[--t2.heap_max] = o2, t2.heap[--t2.heap_max] = l2, a2[2 * h2] = a2[2 * o2] + a2[2 * l2], t2.depth[h2] = (t2.depth[o2] >= t2.depth[l2] ? t2.depth[o2] : t2.depth[l2]) + 1, a2[2 * o2 + 1] = a2[2 * l2 + 1] = h2, t2.heap[1] = h2++, S(t2, a2, 1);
          } while (t2.heap_len >= 2);
          t2.heap[--t2.heap_max] = t2.heap[1], ((t3, e3) => {
            const a3 = e3.dyn_tree, i3 = e3.max_code, n3 = e3.stat_desc.static_tree, r3 = e3.stat_desc.has_stree, o3 = e3.stat_desc.extra_bits, l3 = e3.stat_desc.extra_base, h3 = e3.stat_desc.max_length;
            let d3, _2, f2, c2, u2, w2, m2 = 0;
            for (c2 = 0; c2 <= s; c2++) t3.bl_count[c2] = 0;
            for (a3[2 * t3.heap[t3.heap_max] + 1] = 0, d3 = t3.heap_max + 1; d3 < 573; d3++) _2 = t3.heap[d3], c2 = a3[2 * a3[2 * _2 + 1] + 1] + 1, c2 > h3 && (c2 = h3, m2++), a3[2 * _2 + 1] = c2, _2 > i3 || (t3.bl_count[c2]++, u2 = 0, _2 >= l3 && (u2 = o3[_2 - l3]), w2 = a3[2 * _2], t3.opt_len += w2 * (c2 + u2), r3 && (t3.static_len += w2 * (n3[2 * _2 + 1] + u2)));
            if (0 !== m2) {
              do {
                for (c2 = h3 - 1; 0 === t3.bl_count[c2]; ) c2--;
                t3.bl_count[c2]--, t3.bl_count[c2 + 1] += 2, t3.bl_count[h3]--, m2 -= 2;
              } while (m2 > 0);
              for (c2 = h3; 0 !== c2; c2--) for (_2 = t3.bl_count[c2]; 0 !== _2; ) f2 = t3.heap[--d3], f2 > i3 || (a3[2 * f2 + 1] !== c2 && (t3.opt_len += (c2 - a3[2 * f2 + 1]) * a3[2 * f2], a3[2 * f2 + 1] = c2), _2--);
            }
          })(t2, e2), E(a2, d2, t2.bl_count);
        }, O = (t2, e2, a2) => {
          let i2, n2, s2 = -1, r2 = e2[1], o2 = 0, l2 = 7, h2 = 4;
          for (0 === r2 && (l2 = 138, h2 = 3), e2[2 * (a2 + 1) + 1] = 65535, i2 = 0; i2 <= a2; i2++) n2 = r2, r2 = e2[2 * (i2 + 1) + 1], ++o2 < l2 && n2 === r2 || (o2 < h2 ? t2.bl_tree[2 * n2] += o2 : 0 !== n2 ? (n2 !== s2 && t2.bl_tree[2 * n2]++, t2.bl_tree[32]++) : o2 <= 10 ? t2.bl_tree[34]++ : t2.bl_tree[36]++, o2 = 0, s2 = n2, 0 === r2 ? (l2 = 138, h2 = 3) : n2 === r2 ? (l2 = 6, h2 = 3) : (l2 = 7, h2 = 4));
        }, I = (t2, e2, a2) => {
          let i2, n2, s2 = -1, r2 = e2[1], o2 = 0, l2 = 7, h2 = 4;
          for (0 === r2 && (l2 = 138, h2 = 3), i2 = 0; i2 <= a2; i2++) if (n2 = r2, r2 = e2[2 * (i2 + 1) + 1], !(++o2 < l2 && n2 === r2)) {
            if (o2 < h2) do {
              z(t2, n2, t2.bl_tree);
            } while (0 != --o2);
            else 0 !== n2 ? (n2 !== s2 && (z(t2, n2, t2.bl_tree), o2--), z(t2, 16, t2.bl_tree), x(t2, o2 - 3, 2)) : o2 <= 10 ? (z(t2, 17, t2.bl_tree), x(t2, o2 - 3, 3)) : (z(t2, 18, t2.bl_tree), x(t2, o2 - 11, 7));
            o2 = 0, s2 = n2, 0 === r2 ? (l2 = 138, h2 = 3) : n2 === r2 ? (l2 = 6, h2 = 3) : (l2 = 7, h2 = 4);
          }
        };
        let F = false;
        const L = (t2, e2, a2, i2) => {
          x(t2, 0 + (i2 ? 1 : 0), 3), Z(t2), y(t2, a2), y(t2, ~a2), a2 && t2.pending_buf.set(t2.window.subarray(e2, e2 + a2), t2.pending), t2.pending += a2;
        };
        var N = (t2, e2, i2, n2) => {
          let s2, r2, o2 = 0;
          t2.level > 0 ? (2 === t2.strm.data_type && (t2.strm.data_type = ((t3) => {
            let e3, i3 = 4093624447;
            for (e3 = 0; e3 <= 31; e3++, i3 >>>= 1) if (1 & i3 && 0 !== t3.dyn_ltree[2 * e3]) return 0;
            if (0 !== t3.dyn_ltree[18] || 0 !== t3.dyn_ltree[20] || 0 !== t3.dyn_ltree[26]) return 1;
            for (e3 = 32; e3 < a; e3++) if (0 !== t3.dyn_ltree[2 * e3]) return 1;
            return 0;
          })(t2)), T(t2, t2.l_desc), T(t2, t2.d_desc), o2 = ((t3) => {
            let e3;
            for (O(t3, t3.dyn_ltree, t3.l_desc.max_code), O(t3, t3.dyn_dtree, t3.d_desc.max_code), T(t3, t3.bl_desc), e3 = 18; e3 >= 3 && 0 === t3.bl_tree[2 * h[e3] + 1]; e3--) ;
            return t3.opt_len += 3 * (e3 + 1) + 5 + 5 + 4, e3;
          })(t2), s2 = t2.opt_len + 3 + 7 >>> 3, r2 = t2.static_len + 3 + 7 >>> 3, r2 <= s2 && (s2 = r2)) : s2 = r2 = i2 + 5, i2 + 4 <= s2 && -1 !== e2 ? L(t2, e2, i2, n2) : 4 === t2.strategy || r2 === s2 ? (x(t2, 2 + (n2 ? 1 : 0), 3), D(t2, d, _)) : (x(t2, 4 + (n2 ? 1 : 0), 3), ((t3, e3, a2, i3) => {
            let n3;
            for (x(t3, e3 - 257, 5), x(t3, a2 - 1, 5), x(t3, i3 - 4, 4), n3 = 0; n3 < i3; n3++) x(t3, t3.bl_tree[2 * h[n3] + 1], 3);
            I(t3, t3.dyn_ltree, e3 - 1), I(t3, t3.dyn_dtree, a2 - 1);
          })(t2, t2.l_desc.max_code + 1, t2.d_desc.max_code + 1, o2 + 1), D(t2, t2.dyn_ltree, t2.dyn_dtree)), R(t2), n2 && Z(t2);
        }, B = { _tr_init: (t2) => {
          F || ((() => {
            let t3, e2, a2, h2, k2;
            const v2 = new Array(16);
            for (a2 = 0, h2 = 0; h2 < 28; h2++) for (u[h2] = a2, t3 = 0; t3 < 1 << r[h2]; t3++) c[a2++] = h2;
            for (c[a2 - 1] = h2, k2 = 0, h2 = 0; h2 < 16; h2++) for (w[h2] = k2, t3 = 0; t3 < 1 << o[h2]; t3++) f[k2++] = h2;
            for (k2 >>= 7; h2 < n; h2++) for (w[h2] = k2 << 7, t3 = 0; t3 < 1 << o[h2] - 7; t3++) f[256 + k2++] = h2;
            for (e2 = 0; e2 <= s; e2++) v2[e2] = 0;
            for (t3 = 0; t3 <= 143; ) d[2 * t3 + 1] = 8, t3++, v2[8]++;
            for (; t3 <= 255; ) d[2 * t3 + 1] = 9, t3++, v2[9]++;
            for (; t3 <= 279; ) d[2 * t3 + 1] = 7, t3++, v2[7]++;
            for (; t3 <= 287; ) d[2 * t3 + 1] = 8, t3++, v2[8]++;
            for (E(d, 287, v2), t3 = 0; t3 < n; t3++) _[2 * t3 + 1] = 5, _[2 * t3] = A(t3, 5);
            b = new m(d, r, 257, i, s), g = new m(_, o, 0, n, s), p = new m(new Array(0), l, 0, 19, 7);
          })(), F = true), t2.l_desc = new k(t2.dyn_ltree, b), t2.d_desc = new k(t2.dyn_dtree, g), t2.bl_desc = new k(t2.bl_tree, p), t2.bi_buf = 0, t2.bi_valid = 0, R(t2);
        }, _tr_stored_block: L, _tr_flush_block: N, _tr_tally: (t2, e2, i2) => (t2.pending_buf[t2.sym_buf + t2.sym_next++] = e2, t2.pending_buf[t2.sym_buf + t2.sym_next++] = e2 >> 8, t2.pending_buf[t2.sym_buf + t2.sym_next++] = i2, 0 === e2 ? t2.dyn_ltree[2 * i2]++ : (t2.matches++, e2--, t2.dyn_ltree[2 * (c[i2] + a + 1)]++, t2.dyn_dtree[2 * v(e2)]++), t2.sym_next === t2.sym_end), _tr_align: (t2) => {
          x(t2, 2, 3), z(t2, 256, d), ((t3) => {
            16 === t3.bi_valid ? (y(t3, t3.bi_buf), t3.bi_buf = 0, t3.bi_valid = 0) : t3.bi_valid >= 8 && (t3.pending_buf[t3.pending++] = 255 & t3.bi_buf, t3.bi_buf >>= 8, t3.bi_valid -= 8);
          })(t2);
        } };
        var C = (t2, e2, a2, i2) => {
          let n2 = 65535 & t2 | 0, s2 = t2 >>> 16 & 65535 | 0, r2 = 0;
          for (; 0 !== a2; ) {
            r2 = a2 > 2e3 ? 2e3 : a2, a2 -= r2;
            do {
              n2 = n2 + e2[i2++] | 0, s2 = s2 + n2 | 0;
            } while (--r2);
            n2 %= 65521, s2 %= 65521;
          }
          return n2 | s2 << 16 | 0;
        };
        const M = new Uint32Array((() => {
          let t2, e2 = [];
          for (var a2 = 0; a2 < 256; a2++) {
            t2 = a2;
            for (var i2 = 0; i2 < 8; i2++) t2 = 1 & t2 ? 3988292384 ^ t2 >>> 1 : t2 >>> 1;
            e2[a2] = t2;
          }
          return e2;
        })());
        var H = (t2, e2, a2, i2) => {
          const n2 = M, s2 = i2 + a2;
          t2 ^= -1;
          for (let a3 = i2; a3 < s2; a3++) t2 = t2 >>> 8 ^ n2[255 & (t2 ^ e2[a3])];
          return -1 ^ t2;
        }, j = { 2: "need dictionary", 1: "stream end", 0: "", "-1": "file error", "-2": "stream error", "-3": "data error", "-4": "insufficient memory", "-5": "buffer error", "-6": "incompatible version" }, K = { Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5, Z_TREES: 6, Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1, Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0, Z_BINARY: 0, Z_TEXT: 1, Z_UNKNOWN: 2, Z_DEFLATED: 8 };
        const { _tr_init: P, _tr_stored_block: Y, _tr_flush_block: G, _tr_tally: X, _tr_align: W } = B, { Z_NO_FLUSH: q, Z_PARTIAL_FLUSH: J, Z_FULL_FLUSH: Q, Z_FINISH: V, Z_BLOCK: $, Z_OK: tt, Z_STREAM_END: et, Z_STREAM_ERROR: at, Z_DATA_ERROR: it, Z_BUF_ERROR: nt, Z_DEFAULT_COMPRESSION: st, Z_FILTERED: rt, Z_HUFFMAN_ONLY: ot, Z_RLE: lt, Z_FIXED: ht, Z_DEFAULT_STRATEGY: dt, Z_UNKNOWN: _t, Z_DEFLATED: ft } = K, ct = 258, ut = 262, wt = 42, mt = 113, bt = 666, gt = (t2, e2) => (t2.msg = j[e2], e2), pt = (t2) => 2 * t2 - (t2 > 4 ? 9 : 0), kt = (t2) => {
          let e2 = t2.length;
          for (; --e2 >= 0; ) t2[e2] = 0;
        }, vt = (t2) => {
          let e2, a2, i2, n2 = t2.w_size;
          e2 = t2.hash_size, i2 = e2;
          do {
            a2 = t2.head[--i2], t2.head[i2] = a2 >= n2 ? a2 - n2 : 0;
          } while (--e2);
          e2 = n2, i2 = e2;
          do {
            a2 = t2.prev[--i2], t2.prev[i2] = a2 >= n2 ? a2 - n2 : 0;
          } while (--e2);
        };
        let yt = (t2, e2, a2) => (e2 << t2.hash_shift ^ a2) & t2.hash_mask;
        const xt = (t2) => {
          const e2 = t2.state;
          let a2 = e2.pending;
          a2 > t2.avail_out && (a2 = t2.avail_out), 0 !== a2 && (t2.output.set(e2.pending_buf.subarray(e2.pending_out, e2.pending_out + a2), t2.next_out), t2.next_out += a2, e2.pending_out += a2, t2.total_out += a2, t2.avail_out -= a2, e2.pending -= a2, 0 === e2.pending && (e2.pending_out = 0));
        }, zt = (t2, e2) => {
          G(t2, t2.block_start >= 0 ? t2.block_start : -1, t2.strstart - t2.block_start, e2), t2.block_start = t2.strstart, xt(t2.strm);
        }, At = (t2, e2) => {
          t2.pending_buf[t2.pending++] = e2;
        }, Et = (t2, e2) => {
          t2.pending_buf[t2.pending++] = e2 >>> 8 & 255, t2.pending_buf[t2.pending++] = 255 & e2;
        }, Rt = (t2, e2, a2, i2) => {
          let n2 = t2.avail_in;
          return n2 > i2 && (n2 = i2), 0 === n2 ? 0 : (t2.avail_in -= n2, e2.set(t2.input.subarray(t2.next_in, t2.next_in + n2), a2), 1 === t2.state.wrap ? t2.adler = C(t2.adler, e2, n2, a2) : 2 === t2.state.wrap && (t2.adler = H(t2.adler, e2, n2, a2)), t2.next_in += n2, t2.total_in += n2, n2);
        }, Zt = (t2, e2) => {
          let a2, i2, n2 = t2.max_chain_length, s2 = t2.strstart, r2 = t2.prev_length, o2 = t2.nice_match;
          const l2 = t2.strstart > t2.w_size - ut ? t2.strstart - (t2.w_size - ut) : 0, h2 = t2.window, d2 = t2.w_mask, _2 = t2.prev, f2 = t2.strstart + ct;
          let c2 = h2[s2 + r2 - 1], u2 = h2[s2 + r2];
          t2.prev_length >= t2.good_match && (n2 >>= 2), o2 > t2.lookahead && (o2 = t2.lookahead);
          do {
            if (a2 = e2, h2[a2 + r2] === u2 && h2[a2 + r2 - 1] === c2 && h2[a2] === h2[s2] && h2[++a2] === h2[s2 + 1]) {
              s2 += 2, a2++;
              do {
              } while (h2[++s2] === h2[++a2] && h2[++s2] === h2[++a2] && h2[++s2] === h2[++a2] && h2[++s2] === h2[++a2] && h2[++s2] === h2[++a2] && h2[++s2] === h2[++a2] && h2[++s2] === h2[++a2] && h2[++s2] === h2[++a2] && s2 < f2);
              if (i2 = ct - (f2 - s2), s2 = f2 - ct, i2 > r2) {
                if (t2.match_start = e2, r2 = i2, i2 >= o2) break;
                c2 = h2[s2 + r2 - 1], u2 = h2[s2 + r2];
              }
            }
          } while ((e2 = _2[e2 & d2]) > l2 && 0 != --n2);
          return r2 <= t2.lookahead ? r2 : t2.lookahead;
        }, Ut = (t2) => {
          const e2 = t2.w_size;
          let a2, i2, n2;
          do {
            if (i2 = t2.window_size - t2.lookahead - t2.strstart, t2.strstart >= e2 + (e2 - ut) && (t2.window.set(t2.window.subarray(e2, e2 + e2 - i2), 0), t2.match_start -= e2, t2.strstart -= e2, t2.block_start -= e2, t2.insert > t2.strstart && (t2.insert = t2.strstart), vt(t2), i2 += e2), 0 === t2.strm.avail_in) break;
            if (a2 = Rt(t2.strm, t2.window, t2.strstart + t2.lookahead, i2), t2.lookahead += a2, t2.lookahead + t2.insert >= 3) for (n2 = t2.strstart - t2.insert, t2.ins_h = t2.window[n2], t2.ins_h = yt(t2, t2.ins_h, t2.window[n2 + 1]); t2.insert && (t2.ins_h = yt(t2, t2.ins_h, t2.window[n2 + 3 - 1]), t2.prev[n2 & t2.w_mask] = t2.head[t2.ins_h], t2.head[t2.ins_h] = n2, n2++, t2.insert--, !(t2.lookahead + t2.insert < 3)); ) ;
          } while (t2.lookahead < ut && 0 !== t2.strm.avail_in);
        }, St = (t2, e2) => {
          let a2, i2, n2, s2 = t2.pending_buf_size - 5 > t2.w_size ? t2.w_size : t2.pending_buf_size - 5, r2 = 0, o2 = t2.strm.avail_in;
          do {
            if (a2 = 65535, n2 = t2.bi_valid + 42 >> 3, t2.strm.avail_out < n2) break;
            if (n2 = t2.strm.avail_out - n2, i2 = t2.strstart - t2.block_start, a2 > i2 + t2.strm.avail_in && (a2 = i2 + t2.strm.avail_in), a2 > n2 && (a2 = n2), a2 < s2 && (0 === a2 && e2 !== V || e2 === q || a2 !== i2 + t2.strm.avail_in)) break;
            r2 = e2 === V && a2 === i2 + t2.strm.avail_in ? 1 : 0, Y(t2, 0, 0, r2), t2.pending_buf[t2.pending - 4] = a2, t2.pending_buf[t2.pending - 3] = a2 >> 8, t2.pending_buf[t2.pending - 2] = ~a2, t2.pending_buf[t2.pending - 1] = ~a2 >> 8, xt(t2.strm), i2 && (i2 > a2 && (i2 = a2), t2.strm.output.set(t2.window.subarray(t2.block_start, t2.block_start + i2), t2.strm.next_out), t2.strm.next_out += i2, t2.strm.avail_out -= i2, t2.strm.total_out += i2, t2.block_start += i2, a2 -= i2), a2 && (Rt(t2.strm, t2.strm.output, t2.strm.next_out, a2), t2.strm.next_out += a2, t2.strm.avail_out -= a2, t2.strm.total_out += a2);
          } while (0 === r2);
          return o2 -= t2.strm.avail_in, o2 && (o2 >= t2.w_size ? (t2.matches = 2, t2.window.set(t2.strm.input.subarray(t2.strm.next_in - t2.w_size, t2.strm.next_in), 0), t2.strstart = t2.w_size, t2.insert = t2.strstart) : (t2.window_size - t2.strstart <= o2 && (t2.strstart -= t2.w_size, t2.window.set(t2.window.subarray(t2.w_size, t2.w_size + t2.strstart), 0), t2.matches < 2 && t2.matches++, t2.insert > t2.strstart && (t2.insert = t2.strstart)), t2.window.set(t2.strm.input.subarray(t2.strm.next_in - o2, t2.strm.next_in), t2.strstart), t2.strstart += o2, t2.insert += o2 > t2.w_size - t2.insert ? t2.w_size - t2.insert : o2), t2.block_start = t2.strstart), t2.high_water < t2.strstart && (t2.high_water = t2.strstart), r2 ? 4 : e2 !== q && e2 !== V && 0 === t2.strm.avail_in && t2.strstart === t2.block_start ? 2 : (n2 = t2.window_size - t2.strstart, t2.strm.avail_in > n2 && t2.block_start >= t2.w_size && (t2.block_start -= t2.w_size, t2.strstart -= t2.w_size, t2.window.set(t2.window.subarray(t2.w_size, t2.w_size + t2.strstart), 0), t2.matches < 2 && t2.matches++, n2 += t2.w_size, t2.insert > t2.strstart && (t2.insert = t2.strstart)), n2 > t2.strm.avail_in && (n2 = t2.strm.avail_in), n2 && (Rt(t2.strm, t2.window, t2.strstart, n2), t2.strstart += n2, t2.insert += n2 > t2.w_size - t2.insert ? t2.w_size - t2.insert : n2), t2.high_water < t2.strstart && (t2.high_water = t2.strstart), n2 = t2.bi_valid + 42 >> 3, n2 = t2.pending_buf_size - n2 > 65535 ? 65535 : t2.pending_buf_size - n2, s2 = n2 > t2.w_size ? t2.w_size : n2, i2 = t2.strstart - t2.block_start, (i2 >= s2 || (i2 || e2 === V) && e2 !== q && 0 === t2.strm.avail_in && i2 <= n2) && (a2 = i2 > n2 ? n2 : i2, r2 = e2 === V && 0 === t2.strm.avail_in && a2 === i2 ? 1 : 0, Y(t2, t2.block_start, a2, r2), t2.block_start += a2, xt(t2.strm)), r2 ? 3 : 1);
        }, Dt = (t2, e2) => {
          let a2, i2;
          for (; ; ) {
            if (t2.lookahead < ut) {
              if (Ut(t2), t2.lookahead < ut && e2 === q) return 1;
              if (0 === t2.lookahead) break;
            }
            if (a2 = 0, t2.lookahead >= 3 && (t2.ins_h = yt(t2, t2.ins_h, t2.window[t2.strstart + 3 - 1]), a2 = t2.prev[t2.strstart & t2.w_mask] = t2.head[t2.ins_h], t2.head[t2.ins_h] = t2.strstart), 0 !== a2 && t2.strstart - a2 <= t2.w_size - ut && (t2.match_length = Zt(t2, a2)), t2.match_length >= 3) if (i2 = X(t2, t2.strstart - t2.match_start, t2.match_length - 3), t2.lookahead -= t2.match_length, t2.match_length <= t2.max_lazy_match && t2.lookahead >= 3) {
              t2.match_length--;
              do {
                t2.strstart++, t2.ins_h = yt(t2, t2.ins_h, t2.window[t2.strstart + 3 - 1]), a2 = t2.prev[t2.strstart & t2.w_mask] = t2.head[t2.ins_h], t2.head[t2.ins_h] = t2.strstart;
              } while (0 != --t2.match_length);
              t2.strstart++;
            } else t2.strstart += t2.match_length, t2.match_length = 0, t2.ins_h = t2.window[t2.strstart], t2.ins_h = yt(t2, t2.ins_h, t2.window[t2.strstart + 1]);
            else i2 = X(t2, 0, t2.window[t2.strstart]), t2.lookahead--, t2.strstart++;
            if (i2 && (zt(t2, false), 0 === t2.strm.avail_out)) return 1;
          }
          return t2.insert = t2.strstart < 2 ? t2.strstart : 2, e2 === V ? (zt(t2, true), 0 === t2.strm.avail_out ? 3 : 4) : t2.sym_next && (zt(t2, false), 0 === t2.strm.avail_out) ? 1 : 2;
        }, Tt = (t2, e2) => {
          let a2, i2, n2;
          for (; ; ) {
            if (t2.lookahead < ut) {
              if (Ut(t2), t2.lookahead < ut && e2 === q) return 1;
              if (0 === t2.lookahead) break;
            }
            if (a2 = 0, t2.lookahead >= 3 && (t2.ins_h = yt(t2, t2.ins_h, t2.window[t2.strstart + 3 - 1]), a2 = t2.prev[t2.strstart & t2.w_mask] = t2.head[t2.ins_h], t2.head[t2.ins_h] = t2.strstart), t2.prev_length = t2.match_length, t2.prev_match = t2.match_start, t2.match_length = 2, 0 !== a2 && t2.prev_length < t2.max_lazy_match && t2.strstart - a2 <= t2.w_size - ut && (t2.match_length = Zt(t2, a2), t2.match_length <= 5 && (t2.strategy === rt || 3 === t2.match_length && t2.strstart - t2.match_start > 4096) && (t2.match_length = 2)), t2.prev_length >= 3 && t2.match_length <= t2.prev_length) {
              n2 = t2.strstart + t2.lookahead - 3, i2 = X(t2, t2.strstart - 1 - t2.prev_match, t2.prev_length - 3), t2.lookahead -= t2.prev_length - 1, t2.prev_length -= 2;
              do {
                ++t2.strstart <= n2 && (t2.ins_h = yt(t2, t2.ins_h, t2.window[t2.strstart + 3 - 1]), a2 = t2.prev[t2.strstart & t2.w_mask] = t2.head[t2.ins_h], t2.head[t2.ins_h] = t2.strstart);
              } while (0 != --t2.prev_length);
              if (t2.match_available = 0, t2.match_length = 2, t2.strstart++, i2 && (zt(t2, false), 0 === t2.strm.avail_out)) return 1;
            } else if (t2.match_available) {
              if (i2 = X(t2, 0, t2.window[t2.strstart - 1]), i2 && zt(t2, false), t2.strstart++, t2.lookahead--, 0 === t2.strm.avail_out) return 1;
            } else t2.match_available = 1, t2.strstart++, t2.lookahead--;
          }
          return t2.match_available && (i2 = X(t2, 0, t2.window[t2.strstart - 1]), t2.match_available = 0), t2.insert = t2.strstart < 2 ? t2.strstart : 2, e2 === V ? (zt(t2, true), 0 === t2.strm.avail_out ? 3 : 4) : t2.sym_next && (zt(t2, false), 0 === t2.strm.avail_out) ? 1 : 2;
        };
        function Ot(t2, e2, a2, i2, n2) {
          this.good_length = t2, this.max_lazy = e2, this.nice_length = a2, this.max_chain = i2, this.func = n2;
        }
        const It = [new Ot(0, 0, 0, 0, St), new Ot(4, 4, 8, 4, Dt), new Ot(4, 5, 16, 8, Dt), new Ot(4, 6, 32, 32, Dt), new Ot(4, 4, 16, 16, Tt), new Ot(8, 16, 32, 32, Tt), new Ot(8, 16, 128, 128, Tt), new Ot(8, 32, 128, 256, Tt), new Ot(32, 128, 258, 1024, Tt), new Ot(32, 258, 258, 4096, Tt)];
        function Ft() {
          this.strm = null, this.status = 0, this.pending_buf = null, this.pending_buf_size = 0, this.pending_out = 0, this.pending = 0, this.wrap = 0, this.gzhead = null, this.gzindex = 0, this.method = ft, this.last_flush = -1, this.w_size = 0, this.w_bits = 0, this.w_mask = 0, this.window = null, this.window_size = 0, this.prev = null, this.head = null, this.ins_h = 0, this.hash_size = 0, this.hash_bits = 0, this.hash_mask = 0, this.hash_shift = 0, this.block_start = 0, this.match_length = 0, this.prev_match = 0, this.match_available = 0, this.strstart = 0, this.match_start = 0, this.lookahead = 0, this.prev_length = 0, this.max_chain_length = 0, this.max_lazy_match = 0, this.level = 0, this.strategy = 0, this.good_match = 0, this.nice_match = 0, this.dyn_ltree = new Uint16Array(1146), this.dyn_dtree = new Uint16Array(122), this.bl_tree = new Uint16Array(78), kt(this.dyn_ltree), kt(this.dyn_dtree), kt(this.bl_tree), this.l_desc = null, this.d_desc = null, this.bl_desc = null, this.bl_count = new Uint16Array(16), this.heap = new Uint16Array(573), kt(this.heap), this.heap_len = 0, this.heap_max = 0, this.depth = new Uint16Array(573), kt(this.depth), this.sym_buf = 0, this.lit_bufsize = 0, this.sym_next = 0, this.sym_end = 0, this.opt_len = 0, this.static_len = 0, this.matches = 0, this.insert = 0, this.bi_buf = 0, this.bi_valid = 0;
        }
        const Lt = (t2) => {
          if (!t2) return 1;
          const e2 = t2.state;
          return !e2 || e2.strm !== t2 || e2.status !== wt && 57 !== e2.status && 69 !== e2.status && 73 !== e2.status && 91 !== e2.status && 103 !== e2.status && e2.status !== mt && e2.status !== bt ? 1 : 0;
        }, Nt = (t2) => {
          if (Lt(t2)) return gt(t2, at);
          t2.total_in = t2.total_out = 0, t2.data_type = _t;
          const e2 = t2.state;
          return e2.pending = 0, e2.pending_out = 0, e2.wrap < 0 && (e2.wrap = -e2.wrap), e2.status = 2 === e2.wrap ? 57 : e2.wrap ? wt : mt, t2.adler = 2 === e2.wrap ? 0 : 1, e2.last_flush = -2, P(e2), tt;
        }, Bt = (t2) => {
          const e2 = Nt(t2);
          var a2;
          return e2 === tt && ((a2 = t2.state).window_size = 2 * a2.w_size, kt(a2.head), a2.max_lazy_match = It[a2.level].max_lazy, a2.good_match = It[a2.level].good_length, a2.nice_match = It[a2.level].nice_length, a2.max_chain_length = It[a2.level].max_chain, a2.strstart = 0, a2.block_start = 0, a2.lookahead = 0, a2.insert = 0, a2.match_length = a2.prev_length = 2, a2.match_available = 0, a2.ins_h = 0), e2;
        }, Ct = (t2, e2, a2, i2, n2, s2) => {
          if (!t2) return at;
          let r2 = 1;
          if (e2 === st && (e2 = 6), i2 < 0 ? (r2 = 0, i2 = -i2) : i2 > 15 && (r2 = 2, i2 -= 16), n2 < 1 || n2 > 9 || a2 !== ft || i2 < 8 || i2 > 15 || e2 < 0 || e2 > 9 || s2 < 0 || s2 > ht || 8 === i2 && 1 !== r2) return gt(t2, at);
          8 === i2 && (i2 = 9);
          const o2 = new Ft();
          return t2.state = o2, o2.strm = t2, o2.status = wt, o2.wrap = r2, o2.gzhead = null, o2.w_bits = i2, o2.w_size = 1 << o2.w_bits, o2.w_mask = o2.w_size - 1, o2.hash_bits = n2 + 7, o2.hash_size = 1 << o2.hash_bits, o2.hash_mask = o2.hash_size - 1, o2.hash_shift = ~~((o2.hash_bits + 3 - 1) / 3), o2.window = new Uint8Array(2 * o2.w_size), o2.head = new Uint16Array(o2.hash_size), o2.prev = new Uint16Array(o2.w_size), o2.lit_bufsize = 1 << n2 + 6, o2.pending_buf_size = 4 * o2.lit_bufsize, o2.pending_buf = new Uint8Array(o2.pending_buf_size), o2.sym_buf = o2.lit_bufsize, o2.sym_end = 3 * (o2.lit_bufsize - 1), o2.level = e2, o2.strategy = s2, o2.method = a2, Bt(t2);
        };
        var Mt = { deflateInit: (t2, e2) => Ct(t2, e2, ft, 15, 8, dt), deflateInit2: Ct, deflateReset: Bt, deflateResetKeep: Nt, deflateSetHeader: (t2, e2) => Lt(t2) || 2 !== t2.state.wrap ? at : (t2.state.gzhead = e2, tt), deflate: (t2, e2) => {
          if (Lt(t2) || e2 > $ || e2 < 0) return t2 ? gt(t2, at) : at;
          const a2 = t2.state;
          if (!t2.output || 0 !== t2.avail_in && !t2.input || a2.status === bt && e2 !== V) return gt(t2, 0 === t2.avail_out ? nt : at);
          const i2 = a2.last_flush;
          if (a2.last_flush = e2, 0 !== a2.pending) {
            if (xt(t2), 0 === t2.avail_out) return a2.last_flush = -1, tt;
          } else if (0 === t2.avail_in && pt(e2) <= pt(i2) && e2 !== V) return gt(t2, nt);
          if (a2.status === bt && 0 !== t2.avail_in) return gt(t2, nt);
          if (a2.status === wt && 0 === a2.wrap && (a2.status = mt), a2.status === wt) {
            let e3 = ft + (a2.w_bits - 8 << 4) << 8, i3 = -1;
            if (i3 = a2.strategy >= ot || a2.level < 2 ? 0 : a2.level < 6 ? 1 : 6 === a2.level ? 2 : 3, e3 |= i3 << 6, 0 !== a2.strstart && (e3 |= 32), e3 += 31 - e3 % 31, Et(a2, e3), 0 !== a2.strstart && (Et(a2, t2.adler >>> 16), Et(a2, 65535 & t2.adler)), t2.adler = 1, a2.status = mt, xt(t2), 0 !== a2.pending) return a2.last_flush = -1, tt;
          }
          if (57 === a2.status) {
            if (t2.adler = 0, At(a2, 31), At(a2, 139), At(a2, 8), a2.gzhead) At(a2, (a2.gzhead.text ? 1 : 0) + (a2.gzhead.hcrc ? 2 : 0) + (a2.gzhead.extra ? 4 : 0) + (a2.gzhead.name ? 8 : 0) + (a2.gzhead.comment ? 16 : 0)), At(a2, 255 & a2.gzhead.time), At(a2, a2.gzhead.time >> 8 & 255), At(a2, a2.gzhead.time >> 16 & 255), At(a2, a2.gzhead.time >> 24 & 255), At(a2, 9 === a2.level ? 2 : a2.strategy >= ot || a2.level < 2 ? 4 : 0), At(a2, 255 & a2.gzhead.os), a2.gzhead.extra && a2.gzhead.extra.length && (At(a2, 255 & a2.gzhead.extra.length), At(a2, a2.gzhead.extra.length >> 8 & 255)), a2.gzhead.hcrc && (t2.adler = H(t2.adler, a2.pending_buf, a2.pending, 0)), a2.gzindex = 0, a2.status = 69;
            else if (At(a2, 0), At(a2, 0), At(a2, 0), At(a2, 0), At(a2, 0), At(a2, 9 === a2.level ? 2 : a2.strategy >= ot || a2.level < 2 ? 4 : 0), At(a2, 3), a2.status = mt, xt(t2), 0 !== a2.pending) return a2.last_flush = -1, tt;
          }
          if (69 === a2.status) {
            if (a2.gzhead.extra) {
              let e3 = a2.pending, i3 = (65535 & a2.gzhead.extra.length) - a2.gzindex;
              for (; a2.pending + i3 > a2.pending_buf_size; ) {
                let n3 = a2.pending_buf_size - a2.pending;
                if (a2.pending_buf.set(a2.gzhead.extra.subarray(a2.gzindex, a2.gzindex + n3), a2.pending), a2.pending = a2.pending_buf_size, a2.gzhead.hcrc && a2.pending > e3 && (t2.adler = H(t2.adler, a2.pending_buf, a2.pending - e3, e3)), a2.gzindex += n3, xt(t2), 0 !== a2.pending) return a2.last_flush = -1, tt;
                e3 = 0, i3 -= n3;
              }
              let n2 = new Uint8Array(a2.gzhead.extra);
              a2.pending_buf.set(n2.subarray(a2.gzindex, a2.gzindex + i3), a2.pending), a2.pending += i3, a2.gzhead.hcrc && a2.pending > e3 && (t2.adler = H(t2.adler, a2.pending_buf, a2.pending - e3, e3)), a2.gzindex = 0;
            }
            a2.status = 73;
          }
          if (73 === a2.status) {
            if (a2.gzhead.name) {
              let e3, i3 = a2.pending;
              do {
                if (a2.pending === a2.pending_buf_size) {
                  if (a2.gzhead.hcrc && a2.pending > i3 && (t2.adler = H(t2.adler, a2.pending_buf, a2.pending - i3, i3)), xt(t2), 0 !== a2.pending) return a2.last_flush = -1, tt;
                  i3 = 0;
                }
                e3 = a2.gzindex < a2.gzhead.name.length ? 255 & a2.gzhead.name.charCodeAt(a2.gzindex++) : 0, At(a2, e3);
              } while (0 !== e3);
              a2.gzhead.hcrc && a2.pending > i3 && (t2.adler = H(t2.adler, a2.pending_buf, a2.pending - i3, i3)), a2.gzindex = 0;
            }
            a2.status = 91;
          }
          if (91 === a2.status) {
            if (a2.gzhead.comment) {
              let e3, i3 = a2.pending;
              do {
                if (a2.pending === a2.pending_buf_size) {
                  if (a2.gzhead.hcrc && a2.pending > i3 && (t2.adler = H(t2.adler, a2.pending_buf, a2.pending - i3, i3)), xt(t2), 0 !== a2.pending) return a2.last_flush = -1, tt;
                  i3 = 0;
                }
                e3 = a2.gzindex < a2.gzhead.comment.length ? 255 & a2.gzhead.comment.charCodeAt(a2.gzindex++) : 0, At(a2, e3);
              } while (0 !== e3);
              a2.gzhead.hcrc && a2.pending > i3 && (t2.adler = H(t2.adler, a2.pending_buf, a2.pending - i3, i3));
            }
            a2.status = 103;
          }
          if (103 === a2.status) {
            if (a2.gzhead.hcrc) {
              if (a2.pending + 2 > a2.pending_buf_size && (xt(t2), 0 !== a2.pending)) return a2.last_flush = -1, tt;
              At(a2, 255 & t2.adler), At(a2, t2.adler >> 8 & 255), t2.adler = 0;
            }
            if (a2.status = mt, xt(t2), 0 !== a2.pending) return a2.last_flush = -1, tt;
          }
          if (0 !== t2.avail_in || 0 !== a2.lookahead || e2 !== q && a2.status !== bt) {
            let i3 = 0 === a2.level ? St(a2, e2) : a2.strategy === ot ? ((t3, e3) => {
              let a3;
              for (; ; ) {
                if (0 === t3.lookahead && (Ut(t3), 0 === t3.lookahead)) {
                  if (e3 === q) return 1;
                  break;
                }
                if (t3.match_length = 0, a3 = X(t3, 0, t3.window[t3.strstart]), t3.lookahead--, t3.strstart++, a3 && (zt(t3, false), 0 === t3.strm.avail_out)) return 1;
              }
              return t3.insert = 0, e3 === V ? (zt(t3, true), 0 === t3.strm.avail_out ? 3 : 4) : t3.sym_next && (zt(t3, false), 0 === t3.strm.avail_out) ? 1 : 2;
            })(a2, e2) : a2.strategy === lt ? ((t3, e3) => {
              let a3, i4, n2, s2;
              const r2 = t3.window;
              for (; ; ) {
                if (t3.lookahead <= ct) {
                  if (Ut(t3), t3.lookahead <= ct && e3 === q) return 1;
                  if (0 === t3.lookahead) break;
                }
                if (t3.match_length = 0, t3.lookahead >= 3 && t3.strstart > 0 && (n2 = t3.strstart - 1, i4 = r2[n2], i4 === r2[++n2] && i4 === r2[++n2] && i4 === r2[++n2])) {
                  s2 = t3.strstart + ct;
                  do {
                  } while (i4 === r2[++n2] && i4 === r2[++n2] && i4 === r2[++n2] && i4 === r2[++n2] && i4 === r2[++n2] && i4 === r2[++n2] && i4 === r2[++n2] && i4 === r2[++n2] && n2 < s2);
                  t3.match_length = ct - (s2 - n2), t3.match_length > t3.lookahead && (t3.match_length = t3.lookahead);
                }
                if (t3.match_length >= 3 ? (a3 = X(t3, 1, t3.match_length - 3), t3.lookahead -= t3.match_length, t3.strstart += t3.match_length, t3.match_length = 0) : (a3 = X(t3, 0, t3.window[t3.strstart]), t3.lookahead--, t3.strstart++), a3 && (zt(t3, false), 0 === t3.strm.avail_out)) return 1;
              }
              return t3.insert = 0, e3 === V ? (zt(t3, true), 0 === t3.strm.avail_out ? 3 : 4) : t3.sym_next && (zt(t3, false), 0 === t3.strm.avail_out) ? 1 : 2;
            })(a2, e2) : It[a2.level].func(a2, e2);
            if (3 !== i3 && 4 !== i3 || (a2.status = bt), 1 === i3 || 3 === i3) return 0 === t2.avail_out && (a2.last_flush = -1), tt;
            if (2 === i3 && (e2 === J ? W(a2) : e2 !== $ && (Y(a2, 0, 0, false), e2 === Q && (kt(a2.head), 0 === a2.lookahead && (a2.strstart = 0, a2.block_start = 0, a2.insert = 0))), xt(t2), 0 === t2.avail_out)) return a2.last_flush = -1, tt;
          }
          return e2 !== V ? tt : a2.wrap <= 0 ? et : (2 === a2.wrap ? (At(a2, 255 & t2.adler), At(a2, t2.adler >> 8 & 255), At(a2, t2.adler >> 16 & 255), At(a2, t2.adler >> 24 & 255), At(a2, 255 & t2.total_in), At(a2, t2.total_in >> 8 & 255), At(a2, t2.total_in >> 16 & 255), At(a2, t2.total_in >> 24 & 255)) : (Et(a2, t2.adler >>> 16), Et(a2, 65535 & t2.adler)), xt(t2), a2.wrap > 0 && (a2.wrap = -a2.wrap), 0 !== a2.pending ? tt : et);
        }, deflateEnd: (t2) => {
          if (Lt(t2)) return at;
          const e2 = t2.state.status;
          return t2.state = null, e2 === mt ? gt(t2, it) : tt;
        }, deflateSetDictionary: (t2, e2) => {
          let a2 = e2.length;
          if (Lt(t2)) return at;
          const i2 = t2.state, n2 = i2.wrap;
          if (2 === n2 || 1 === n2 && i2.status !== wt || i2.lookahead) return at;
          if (1 === n2 && (t2.adler = C(t2.adler, e2, a2, 0)), i2.wrap = 0, a2 >= i2.w_size) {
            0 === n2 && (kt(i2.head), i2.strstart = 0, i2.block_start = 0, i2.insert = 0);
            let t3 = new Uint8Array(i2.w_size);
            t3.set(e2.subarray(a2 - i2.w_size, a2), 0), e2 = t3, a2 = i2.w_size;
          }
          const s2 = t2.avail_in, r2 = t2.next_in, o2 = t2.input;
          for (t2.avail_in = a2, t2.next_in = 0, t2.input = e2, Ut(i2); i2.lookahead >= 3; ) {
            let t3 = i2.strstart, e3 = i2.lookahead - 2;
            do {
              i2.ins_h = yt(i2, i2.ins_h, i2.window[t3 + 3 - 1]), i2.prev[t3 & i2.w_mask] = i2.head[i2.ins_h], i2.head[i2.ins_h] = t3, t3++;
            } while (--e3);
            i2.strstart = t3, i2.lookahead = 2, Ut(i2);
          }
          return i2.strstart += i2.lookahead, i2.block_start = i2.strstart, i2.insert = i2.lookahead, i2.lookahead = 0, i2.match_length = i2.prev_length = 2, i2.match_available = 0, t2.next_in = r2, t2.input = o2, t2.avail_in = s2, i2.wrap = n2, tt;
        }, deflateInfo: "pako deflate (from Nodeca project)" };
        const Ht = (t2, e2) => Object.prototype.hasOwnProperty.call(t2, e2);
        var jt = function(t2) {
          const e2 = Array.prototype.slice.call(arguments, 1);
          for (; e2.length; ) {
            const a2 = e2.shift();
            if (a2) {
              if ("object" != typeof a2) throw new TypeError(a2 + "must be non-object");
              for (const e3 in a2) Ht(a2, e3) && (t2[e3] = a2[e3]);
            }
          }
          return t2;
        }, Kt = (t2) => {
          let e2 = 0;
          for (let a3 = 0, i2 = t2.length; a3 < i2; a3++) e2 += t2[a3].length;
          const a2 = new Uint8Array(e2);
          for (let e3 = 0, i2 = 0, n2 = t2.length; e3 < n2; e3++) {
            let n3 = t2[e3];
            a2.set(n3, i2), i2 += n3.length;
          }
          return a2;
        };
        let Pt = true;
        try {
          String.fromCharCode.apply(null, new Uint8Array(1));
        } catch (t2) {
          Pt = false;
        }
        const Yt = new Uint8Array(256);
        for (let t2 = 0; t2 < 256; t2++) Yt[t2] = t2 >= 252 ? 6 : t2 >= 248 ? 5 : t2 >= 240 ? 4 : t2 >= 224 ? 3 : t2 >= 192 ? 2 : 1;
        Yt[254] = Yt[254] = 1;
        var Gt = (t2) => {
          if ("function" == typeof TextEncoder && TextEncoder.prototype.encode) return new TextEncoder().encode(t2);
          let e2, a2, i2, n2, s2, r2 = t2.length, o2 = 0;
          for (n2 = 0; n2 < r2; n2++) a2 = t2.charCodeAt(n2), 55296 == (64512 & a2) && n2 + 1 < r2 && (i2 = t2.charCodeAt(n2 + 1), 56320 == (64512 & i2) && (a2 = 65536 + (a2 - 55296 << 10) + (i2 - 56320), n2++)), o2 += a2 < 128 ? 1 : a2 < 2048 ? 2 : a2 < 65536 ? 3 : 4;
          for (e2 = new Uint8Array(o2), s2 = 0, n2 = 0; s2 < o2; n2++) a2 = t2.charCodeAt(n2), 55296 == (64512 & a2) && n2 + 1 < r2 && (i2 = t2.charCodeAt(n2 + 1), 56320 == (64512 & i2) && (a2 = 65536 + (a2 - 55296 << 10) + (i2 - 56320), n2++)), a2 < 128 ? e2[s2++] = a2 : a2 < 2048 ? (e2[s2++] = 192 | a2 >>> 6, e2[s2++] = 128 | 63 & a2) : a2 < 65536 ? (e2[s2++] = 224 | a2 >>> 12, e2[s2++] = 128 | a2 >>> 6 & 63, e2[s2++] = 128 | 63 & a2) : (e2[s2++] = 240 | a2 >>> 18, e2[s2++] = 128 | a2 >>> 12 & 63, e2[s2++] = 128 | a2 >>> 6 & 63, e2[s2++] = 128 | 63 & a2);
          return e2;
        }, Xt = (t2, e2) => {
          const a2 = e2 || t2.length;
          if ("function" == typeof TextDecoder && TextDecoder.prototype.decode) return new TextDecoder().decode(t2.subarray(0, e2));
          let i2, n2;
          const s2 = new Array(2 * a2);
          for (n2 = 0, i2 = 0; i2 < a2; ) {
            let e3 = t2[i2++];
            if (e3 < 128) {
              s2[n2++] = e3;
              continue;
            }
            let r2 = Yt[e3];
            if (r2 > 4) s2[n2++] = 65533, i2 += r2 - 1;
            else {
              for (e3 &= 2 === r2 ? 31 : 3 === r2 ? 15 : 7; r2 > 1 && i2 < a2; ) e3 = e3 << 6 | 63 & t2[i2++], r2--;
              r2 > 1 ? s2[n2++] = 65533 : e3 < 65536 ? s2[n2++] = e3 : (e3 -= 65536, s2[n2++] = 55296 | e3 >> 10 & 1023, s2[n2++] = 56320 | 1023 & e3);
            }
          }
          return ((t3, e3) => {
            if (e3 < 65534 && t3.subarray && Pt) return String.fromCharCode.apply(null, t3.length === e3 ? t3 : t3.subarray(0, e3));
            let a3 = "";
            for (let i3 = 0; i3 < e3; i3++) a3 += String.fromCharCode(t3[i3]);
            return a3;
          })(s2, n2);
        }, Wt = (t2, e2) => {
          (e2 = e2 || t2.length) > t2.length && (e2 = t2.length);
          let a2 = e2 - 1;
          for (; a2 >= 0 && 128 == (192 & t2[a2]); ) a2--;
          return a2 < 0 || 0 === a2 ? e2 : a2 + Yt[t2[a2]] > e2 ? a2 : e2;
        };
        var qt = function() {
          this.input = null, this.next_in = 0, this.avail_in = 0, this.total_in = 0, this.output = null, this.next_out = 0, this.avail_out = 0, this.total_out = 0, this.msg = "", this.state = null, this.data_type = 2, this.adler = 0;
        };
        const Jt = Object.prototype.toString, { Z_NO_FLUSH: Qt, Z_SYNC_FLUSH: Vt, Z_FULL_FLUSH: $t, Z_FINISH: te, Z_OK: ee, Z_STREAM_END: ae, Z_DEFAULT_COMPRESSION: ie, Z_DEFAULT_STRATEGY: ne, Z_DEFLATED: se } = K;
        function re(t2) {
          this.options = jt({ level: ie, method: se, chunkSize: 16384, windowBits: 15, memLevel: 8, strategy: ne }, t2 || {});
          let e2 = this.options;
          e2.raw && e2.windowBits > 0 ? e2.windowBits = -e2.windowBits : e2.gzip && e2.windowBits > 0 && e2.windowBits < 16 && (e2.windowBits += 16), this.err = 0, this.msg = "", this.ended = false, this.chunks = [], this.strm = new qt(), this.strm.avail_out = 0;
          let a2 = Mt.deflateInit2(this.strm, e2.level, e2.method, e2.windowBits, e2.memLevel, e2.strategy);
          if (a2 !== ee) throw new Error(j[a2]);
          if (e2.header && Mt.deflateSetHeader(this.strm, e2.header), e2.dictionary) {
            let t3;
            if (t3 = "string" == typeof e2.dictionary ? Gt(e2.dictionary) : "[object ArrayBuffer]" === Jt.call(e2.dictionary) ? new Uint8Array(e2.dictionary) : e2.dictionary, a2 = Mt.deflateSetDictionary(this.strm, t3), a2 !== ee) throw new Error(j[a2]);
            this._dict_set = true;
          }
        }
        function oe(t2, e2) {
          const a2 = new re(e2);
          if (a2.push(t2, true), a2.err) throw a2.msg || j[a2.err];
          return a2.result;
        }
        re.prototype.push = function(t2, e2) {
          const a2 = this.strm, i2 = this.options.chunkSize;
          let n2, s2;
          if (this.ended) return false;
          for (s2 = e2 === ~~e2 ? e2 : true === e2 ? te : Qt, "string" == typeof t2 ? a2.input = Gt(t2) : "[object ArrayBuffer]" === Jt.call(t2) ? a2.input = new Uint8Array(t2) : a2.input = t2, a2.next_in = 0, a2.avail_in = a2.input.length; ; ) if (0 === a2.avail_out && (a2.output = new Uint8Array(i2), a2.next_out = 0, a2.avail_out = i2), (s2 === Vt || s2 === $t) && a2.avail_out <= 6) this.onData(a2.output.subarray(0, a2.next_out)), a2.avail_out = 0;
          else {
            if (n2 = Mt.deflate(a2, s2), n2 === ae) return a2.next_out > 0 && this.onData(a2.output.subarray(0, a2.next_out)), n2 = Mt.deflateEnd(this.strm), this.onEnd(n2), this.ended = true, n2 === ee;
            if (0 !== a2.avail_out) {
              if (s2 > 0 && a2.next_out > 0) this.onData(a2.output.subarray(0, a2.next_out)), a2.avail_out = 0;
              else if (0 === a2.avail_in) break;
            } else this.onData(a2.output);
          }
          return true;
        }, re.prototype.onData = function(t2) {
          this.chunks.push(t2);
        }, re.prototype.onEnd = function(t2) {
          t2 === ee && (this.result = Kt(this.chunks)), this.chunks = [], this.err = t2, this.msg = this.strm.msg;
        };
        var le = { Deflate: re, deflate: oe, deflateRaw: function(t2, e2) {
          return (e2 = e2 || {}).raw = true, oe(t2, e2);
        }, gzip: function(t2, e2) {
          return (e2 = e2 || {}).gzip = true, oe(t2, e2);
        }, constants: K };
        const he = 16209;
        var de = function(t2, e2) {
          let a2, i2, n2, s2, r2, o2, l2, h2, d2, _2, f2, c2, u2, w2, m2, b2, g2, p2, k2, v2, y2, x2, z2, A2;
          const E2 = t2.state;
          a2 = t2.next_in, z2 = t2.input, i2 = a2 + (t2.avail_in - 5), n2 = t2.next_out, A2 = t2.output, s2 = n2 - (e2 - t2.avail_out), r2 = n2 + (t2.avail_out - 257), o2 = E2.dmax, l2 = E2.wsize, h2 = E2.whave, d2 = E2.wnext, _2 = E2.window, f2 = E2.hold, c2 = E2.bits, u2 = E2.lencode, w2 = E2.distcode, m2 = (1 << E2.lenbits) - 1, b2 = (1 << E2.distbits) - 1;
          t: do {
            c2 < 15 && (f2 += z2[a2++] << c2, c2 += 8, f2 += z2[a2++] << c2, c2 += 8), g2 = u2[f2 & m2];
            e: for (; ; ) {
              if (p2 = g2 >>> 24, f2 >>>= p2, c2 -= p2, p2 = g2 >>> 16 & 255, 0 === p2) A2[n2++] = 65535 & g2;
              else {
                if (!(16 & p2)) {
                  if (0 == (64 & p2)) {
                    g2 = u2[(65535 & g2) + (f2 & (1 << p2) - 1)];
                    continue e;
                  }
                  if (32 & p2) {
                    E2.mode = 16191;
                    break t;
                  }
                  t2.msg = "invalid literal/length code", E2.mode = he;
                  break t;
                }
                k2 = 65535 & g2, p2 &= 15, p2 && (c2 < p2 && (f2 += z2[a2++] << c2, c2 += 8), k2 += f2 & (1 << p2) - 1, f2 >>>= p2, c2 -= p2), c2 < 15 && (f2 += z2[a2++] << c2, c2 += 8, f2 += z2[a2++] << c2, c2 += 8), g2 = w2[f2 & b2];
                a: for (; ; ) {
                  if (p2 = g2 >>> 24, f2 >>>= p2, c2 -= p2, p2 = g2 >>> 16 & 255, !(16 & p2)) {
                    if (0 == (64 & p2)) {
                      g2 = w2[(65535 & g2) + (f2 & (1 << p2) - 1)];
                      continue a;
                    }
                    t2.msg = "invalid distance code", E2.mode = he;
                    break t;
                  }
                  if (v2 = 65535 & g2, p2 &= 15, c2 < p2 && (f2 += z2[a2++] << c2, c2 += 8, c2 < p2 && (f2 += z2[a2++] << c2, c2 += 8)), v2 += f2 & (1 << p2) - 1, v2 > o2) {
                    t2.msg = "invalid distance too far back", E2.mode = he;
                    break t;
                  }
                  if (f2 >>>= p2, c2 -= p2, p2 = n2 - s2, v2 > p2) {
                    if (p2 = v2 - p2, p2 > h2 && E2.sane) {
                      t2.msg = "invalid distance too far back", E2.mode = he;
                      break t;
                    }
                    if (y2 = 0, x2 = _2, 0 === d2) {
                      if (y2 += l2 - p2, p2 < k2) {
                        k2 -= p2;
                        do {
                          A2[n2++] = _2[y2++];
                        } while (--p2);
                        y2 = n2 - v2, x2 = A2;
                      }
                    } else if (d2 < p2) {
                      if (y2 += l2 + d2 - p2, p2 -= d2, p2 < k2) {
                        k2 -= p2;
                        do {
                          A2[n2++] = _2[y2++];
                        } while (--p2);
                        if (y2 = 0, d2 < k2) {
                          p2 = d2, k2 -= p2;
                          do {
                            A2[n2++] = _2[y2++];
                          } while (--p2);
                          y2 = n2 - v2, x2 = A2;
                        }
                      }
                    } else if (y2 += d2 - p2, p2 < k2) {
                      k2 -= p2;
                      do {
                        A2[n2++] = _2[y2++];
                      } while (--p2);
                      y2 = n2 - v2, x2 = A2;
                    }
                    for (; k2 > 2; ) A2[n2++] = x2[y2++], A2[n2++] = x2[y2++], A2[n2++] = x2[y2++], k2 -= 3;
                    k2 && (A2[n2++] = x2[y2++], k2 > 1 && (A2[n2++] = x2[y2++]));
                  } else {
                    y2 = n2 - v2;
                    do {
                      A2[n2++] = A2[y2++], A2[n2++] = A2[y2++], A2[n2++] = A2[y2++], k2 -= 3;
                    } while (k2 > 2);
                    k2 && (A2[n2++] = A2[y2++], k2 > 1 && (A2[n2++] = A2[y2++]));
                  }
                  break;
                }
              }
              break;
            }
          } while (a2 < i2 && n2 < r2);
          k2 = c2 >> 3, a2 -= k2, c2 -= k2 << 3, f2 &= (1 << c2) - 1, t2.next_in = a2, t2.next_out = n2, t2.avail_in = a2 < i2 ? i2 - a2 + 5 : 5 - (a2 - i2), t2.avail_out = n2 < r2 ? r2 - n2 + 257 : 257 - (n2 - r2), E2.hold = f2, E2.bits = c2;
        };
        const _e = 15, fe = new Uint16Array([3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258, 0, 0]), ce = new Uint8Array([16, 16, 16, 16, 16, 16, 16, 16, 17, 17, 17, 17, 18, 18, 18, 18, 19, 19, 19, 19, 20, 20, 20, 20, 21, 21, 21, 21, 16, 72, 78]), ue = new Uint16Array([1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577, 0, 0]), we = new Uint8Array([16, 16, 16, 16, 17, 17, 18, 18, 19, 19, 20, 20, 21, 21, 22, 22, 23, 23, 24, 24, 25, 25, 26, 26, 27, 27, 28, 28, 29, 29, 64, 64]);
        var me = (t2, e2, a2, i2, n2, s2, r2, o2) => {
          const l2 = o2.bits;
          let h2, d2, _2, f2, c2, u2, w2 = 0, m2 = 0, b2 = 0, g2 = 0, p2 = 0, k2 = 0, v2 = 0, y2 = 0, x2 = 0, z2 = 0, A2 = null;
          const E2 = new Uint16Array(16), R2 = new Uint16Array(16);
          let Z2, U2, S2, D2 = null;
          for (w2 = 0; w2 <= _e; w2++) E2[w2] = 0;
          for (m2 = 0; m2 < i2; m2++) E2[e2[a2 + m2]]++;
          for (p2 = l2, g2 = _e; g2 >= 1 && 0 === E2[g2]; g2--) ;
          if (p2 > g2 && (p2 = g2), 0 === g2) return n2[s2++] = 20971520, n2[s2++] = 20971520, o2.bits = 1, 0;
          for (b2 = 1; b2 < g2 && 0 === E2[b2]; b2++) ;
          for (p2 < b2 && (p2 = b2), y2 = 1, w2 = 1; w2 <= _e; w2++) if (y2 <<= 1, y2 -= E2[w2], y2 < 0) return -1;
          if (y2 > 0 && (0 === t2 || 1 !== g2)) return -1;
          for (R2[1] = 0, w2 = 1; w2 < _e; w2++) R2[w2 + 1] = R2[w2] + E2[w2];
          for (m2 = 0; m2 < i2; m2++) 0 !== e2[a2 + m2] && (r2[R2[e2[a2 + m2]]++] = m2);
          if (0 === t2 ? (A2 = D2 = r2, u2 = 20) : 1 === t2 ? (A2 = fe, D2 = ce, u2 = 257) : (A2 = ue, D2 = we, u2 = 0), z2 = 0, m2 = 0, w2 = b2, c2 = s2, k2 = p2, v2 = 0, _2 = -1, x2 = 1 << p2, f2 = x2 - 1, 1 === t2 && x2 > 852 || 2 === t2 && x2 > 592) return 1;
          for (; ; ) {
            Z2 = w2 - v2, r2[m2] + 1 < u2 ? (U2 = 0, S2 = r2[m2]) : r2[m2] >= u2 ? (U2 = D2[r2[m2] - u2], S2 = A2[r2[m2] - u2]) : (U2 = 96, S2 = 0), h2 = 1 << w2 - v2, d2 = 1 << k2, b2 = d2;
            do {
              d2 -= h2, n2[c2 + (z2 >> v2) + d2] = Z2 << 24 | U2 << 16 | S2 | 0;
            } while (0 !== d2);
            for (h2 = 1 << w2 - 1; z2 & h2; ) h2 >>= 1;
            if (0 !== h2 ? (z2 &= h2 - 1, z2 += h2) : z2 = 0, m2++, 0 == --E2[w2]) {
              if (w2 === g2) break;
              w2 = e2[a2 + r2[m2]];
            }
            if (w2 > p2 && (z2 & f2) !== _2) {
              for (0 === v2 && (v2 = p2), c2 += b2, k2 = w2 - v2, y2 = 1 << k2; k2 + v2 < g2 && (y2 -= E2[k2 + v2], !(y2 <= 0)); ) k2++, y2 <<= 1;
              if (x2 += 1 << k2, 1 === t2 && x2 > 852 || 2 === t2 && x2 > 592) return 1;
              _2 = z2 & f2, n2[_2] = p2 << 24 | k2 << 16 | c2 - s2 | 0;
            }
          }
          return 0 !== z2 && (n2[c2 + z2] = w2 - v2 << 24 | 64 << 16 | 0), o2.bits = p2, 0;
        };
        const { Z_FINISH: be, Z_BLOCK: ge, Z_TREES: pe, Z_OK: ke, Z_STREAM_END: ve, Z_NEED_DICT: ye, Z_STREAM_ERROR: xe, Z_DATA_ERROR: ze, Z_MEM_ERROR: Ae, Z_BUF_ERROR: Ee, Z_DEFLATED: Re } = K, Ze = 16180, Ue = 16190, Se = 16191, De = 16192, Te = 16194, Oe = 16199, Ie = 16200, Fe = 16206, Le = 16209, Ne = (t2) => (t2 >>> 24 & 255) + (t2 >>> 8 & 65280) + ((65280 & t2) << 8) + ((255 & t2) << 24);
        function Be() {
          this.strm = null, this.mode = 0, this.last = false, this.wrap = 0, this.havedict = false, this.flags = 0, this.dmax = 0, this.check = 0, this.total = 0, this.head = null, this.wbits = 0, this.wsize = 0, this.whave = 0, this.wnext = 0, this.window = null, this.hold = 0, this.bits = 0, this.length = 0, this.offset = 0, this.extra = 0, this.lencode = null, this.distcode = null, this.lenbits = 0, this.distbits = 0, this.ncode = 0, this.nlen = 0, this.ndist = 0, this.have = 0, this.next = null, this.lens = new Uint16Array(320), this.work = new Uint16Array(288), this.lendyn = null, this.distdyn = null, this.sane = 0, this.back = 0, this.was = 0;
        }
        const Ce = (t2) => {
          if (!t2) return 1;
          const e2 = t2.state;
          return !e2 || e2.strm !== t2 || e2.mode < Ze || e2.mode > 16211 ? 1 : 0;
        }, Me = (t2) => {
          if (Ce(t2)) return xe;
          const e2 = t2.state;
          return t2.total_in = t2.total_out = e2.total = 0, t2.msg = "", e2.wrap && (t2.adler = 1 & e2.wrap), e2.mode = Ze, e2.last = 0, e2.havedict = 0, e2.flags = -1, e2.dmax = 32768, e2.head = null, e2.hold = 0, e2.bits = 0, e2.lencode = e2.lendyn = new Int32Array(852), e2.distcode = e2.distdyn = new Int32Array(592), e2.sane = 1, e2.back = -1, ke;
        }, He = (t2) => {
          if (Ce(t2)) return xe;
          const e2 = t2.state;
          return e2.wsize = 0, e2.whave = 0, e2.wnext = 0, Me(t2);
        }, je = (t2, e2) => {
          let a2;
          if (Ce(t2)) return xe;
          const i2 = t2.state;
          return e2 < 0 ? (a2 = 0, e2 = -e2) : (a2 = 5 + (e2 >> 4), e2 < 48 && (e2 &= 15)), e2 && (e2 < 8 || e2 > 15) ? xe : (null !== i2.window && i2.wbits !== e2 && (i2.window = null), i2.wrap = a2, i2.wbits = e2, He(t2));
        }, Ke = (t2, e2) => {
          if (!t2) return xe;
          const a2 = new Be();
          t2.state = a2, a2.strm = t2, a2.window = null, a2.mode = Ze;
          const i2 = je(t2, e2);
          return i2 !== ke && (t2.state = null), i2;
        };
        let Pe, Ye, Ge = true;
        const Xe = (t2) => {
          if (Ge) {
            Pe = new Int32Array(512), Ye = new Int32Array(32);
            let e2 = 0;
            for (; e2 < 144; ) t2.lens[e2++] = 8;
            for (; e2 < 256; ) t2.lens[e2++] = 9;
            for (; e2 < 280; ) t2.lens[e2++] = 7;
            for (; e2 < 288; ) t2.lens[e2++] = 8;
            for (me(1, t2.lens, 0, 288, Pe, 0, t2.work, { bits: 9 }), e2 = 0; e2 < 32; ) t2.lens[e2++] = 5;
            me(2, t2.lens, 0, 32, Ye, 0, t2.work, { bits: 5 }), Ge = false;
          }
          t2.lencode = Pe, t2.lenbits = 9, t2.distcode = Ye, t2.distbits = 5;
        }, We = (t2, e2, a2, i2) => {
          let n2;
          const s2 = t2.state;
          return null === s2.window && (s2.wsize = 1 << s2.wbits, s2.wnext = 0, s2.whave = 0, s2.window = new Uint8Array(s2.wsize)), i2 >= s2.wsize ? (s2.window.set(e2.subarray(a2 - s2.wsize, a2), 0), s2.wnext = 0, s2.whave = s2.wsize) : (n2 = s2.wsize - s2.wnext, n2 > i2 && (n2 = i2), s2.window.set(e2.subarray(a2 - i2, a2 - i2 + n2), s2.wnext), (i2 -= n2) ? (s2.window.set(e2.subarray(a2 - i2, a2), 0), s2.wnext = i2, s2.whave = s2.wsize) : (s2.wnext += n2, s2.wnext === s2.wsize && (s2.wnext = 0), s2.whave < s2.wsize && (s2.whave += n2))), 0;
        };
        var qe = { inflateReset: He, inflateReset2: je, inflateResetKeep: Me, inflateInit: (t2) => Ke(t2, 15), inflateInit2: Ke, inflate: (t2, e2) => {
          let a2, i2, n2, s2, r2, o2, l2, h2, d2, _2, f2, c2, u2, w2, m2, b2, g2, p2, k2, v2, y2, x2, z2 = 0;
          const A2 = new Uint8Array(4);
          let E2, R2;
          const Z2 = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
          if (Ce(t2) || !t2.output || !t2.input && 0 !== t2.avail_in) return xe;
          a2 = t2.state, a2.mode === Se && (a2.mode = De), r2 = t2.next_out, n2 = t2.output, l2 = t2.avail_out, s2 = t2.next_in, i2 = t2.input, o2 = t2.avail_in, h2 = a2.hold, d2 = a2.bits, _2 = o2, f2 = l2, x2 = ke;
          t: for (; ; ) switch (a2.mode) {
            case Ze:
              if (0 === a2.wrap) {
                a2.mode = De;
                break;
              }
              for (; d2 < 16; ) {
                if (0 === o2) break t;
                o2--, h2 += i2[s2++] << d2, d2 += 8;
              }
              if (2 & a2.wrap && 35615 === h2) {
                0 === a2.wbits && (a2.wbits = 15), a2.check = 0, A2[0] = 255 & h2, A2[1] = h2 >>> 8 & 255, a2.check = H(a2.check, A2, 2, 0), h2 = 0, d2 = 0, a2.mode = 16181;
                break;
              }
              if (a2.head && (a2.head.done = false), !(1 & a2.wrap) || (((255 & h2) << 8) + (h2 >> 8)) % 31) {
                t2.msg = "incorrect header check", a2.mode = Le;
                break;
              }
              if ((15 & h2) !== Re) {
                t2.msg = "unknown compression method", a2.mode = Le;
                break;
              }
              if (h2 >>>= 4, d2 -= 4, y2 = 8 + (15 & h2), 0 === a2.wbits && (a2.wbits = y2), y2 > 15 || y2 > a2.wbits) {
                t2.msg = "invalid window size", a2.mode = Le;
                break;
              }
              a2.dmax = 1 << a2.wbits, a2.flags = 0, t2.adler = a2.check = 1, a2.mode = 512 & h2 ? 16189 : Se, h2 = 0, d2 = 0;
              break;
            case 16181:
              for (; d2 < 16; ) {
                if (0 === o2) break t;
                o2--, h2 += i2[s2++] << d2, d2 += 8;
              }
              if (a2.flags = h2, (255 & a2.flags) !== Re) {
                t2.msg = "unknown compression method", a2.mode = Le;
                break;
              }
              if (57344 & a2.flags) {
                t2.msg = "unknown header flags set", a2.mode = Le;
                break;
              }
              a2.head && (a2.head.text = h2 >> 8 & 1), 512 & a2.flags && 4 & a2.wrap && (A2[0] = 255 & h2, A2[1] = h2 >>> 8 & 255, a2.check = H(a2.check, A2, 2, 0)), h2 = 0, d2 = 0, a2.mode = 16182;
            case 16182:
              for (; d2 < 32; ) {
                if (0 === o2) break t;
                o2--, h2 += i2[s2++] << d2, d2 += 8;
              }
              a2.head && (a2.head.time = h2), 512 & a2.flags && 4 & a2.wrap && (A2[0] = 255 & h2, A2[1] = h2 >>> 8 & 255, A2[2] = h2 >>> 16 & 255, A2[3] = h2 >>> 24 & 255, a2.check = H(a2.check, A2, 4, 0)), h2 = 0, d2 = 0, a2.mode = 16183;
            case 16183:
              for (; d2 < 16; ) {
                if (0 === o2) break t;
                o2--, h2 += i2[s2++] << d2, d2 += 8;
              }
              a2.head && (a2.head.xflags = 255 & h2, a2.head.os = h2 >> 8), 512 & a2.flags && 4 & a2.wrap && (A2[0] = 255 & h2, A2[1] = h2 >>> 8 & 255, a2.check = H(a2.check, A2, 2, 0)), h2 = 0, d2 = 0, a2.mode = 16184;
            case 16184:
              if (1024 & a2.flags) {
                for (; d2 < 16; ) {
                  if (0 === o2) break t;
                  o2--, h2 += i2[s2++] << d2, d2 += 8;
                }
                a2.length = h2, a2.head && (a2.head.extra_len = h2), 512 & a2.flags && 4 & a2.wrap && (A2[0] = 255 & h2, A2[1] = h2 >>> 8 & 255, a2.check = H(a2.check, A2, 2, 0)), h2 = 0, d2 = 0;
              } else a2.head && (a2.head.extra = null);
              a2.mode = 16185;
            case 16185:
              if (1024 & a2.flags && (c2 = a2.length, c2 > o2 && (c2 = o2), c2 && (a2.head && (y2 = a2.head.extra_len - a2.length, a2.head.extra || (a2.head.extra = new Uint8Array(a2.head.extra_len)), a2.head.extra.set(i2.subarray(s2, s2 + c2), y2)), 512 & a2.flags && 4 & a2.wrap && (a2.check = H(a2.check, i2, c2, s2)), o2 -= c2, s2 += c2, a2.length -= c2), a2.length)) break t;
              a2.length = 0, a2.mode = 16186;
            case 16186:
              if (2048 & a2.flags) {
                if (0 === o2) break t;
                c2 = 0;
                do {
                  y2 = i2[s2 + c2++], a2.head && y2 && a2.length < 65536 && (a2.head.name += String.fromCharCode(y2));
                } while (y2 && c2 < o2);
                if (512 & a2.flags && 4 & a2.wrap && (a2.check = H(a2.check, i2, c2, s2)), o2 -= c2, s2 += c2, y2) break t;
              } else a2.head && (a2.head.name = null);
              a2.length = 0, a2.mode = 16187;
            case 16187:
              if (4096 & a2.flags) {
                if (0 === o2) break t;
                c2 = 0;
                do {
                  y2 = i2[s2 + c2++], a2.head && y2 && a2.length < 65536 && (a2.head.comment += String.fromCharCode(y2));
                } while (y2 && c2 < o2);
                if (512 & a2.flags && 4 & a2.wrap && (a2.check = H(a2.check, i2, c2, s2)), o2 -= c2, s2 += c2, y2) break t;
              } else a2.head && (a2.head.comment = null);
              a2.mode = 16188;
            case 16188:
              if (512 & a2.flags) {
                for (; d2 < 16; ) {
                  if (0 === o2) break t;
                  o2--, h2 += i2[s2++] << d2, d2 += 8;
                }
                if (4 & a2.wrap && h2 !== (65535 & a2.check)) {
                  t2.msg = "header crc mismatch", a2.mode = Le;
                  break;
                }
                h2 = 0, d2 = 0;
              }
              a2.head && (a2.head.hcrc = a2.flags >> 9 & 1, a2.head.done = true), t2.adler = a2.check = 0, a2.mode = Se;
              break;
            case 16189:
              for (; d2 < 32; ) {
                if (0 === o2) break t;
                o2--, h2 += i2[s2++] << d2, d2 += 8;
              }
              t2.adler = a2.check = Ne(h2), h2 = 0, d2 = 0, a2.mode = Ue;
            case Ue:
              if (0 === a2.havedict) return t2.next_out = r2, t2.avail_out = l2, t2.next_in = s2, t2.avail_in = o2, a2.hold = h2, a2.bits = d2, ye;
              t2.adler = a2.check = 1, a2.mode = Se;
            case Se:
              if (e2 === ge || e2 === pe) break t;
            case De:
              if (a2.last) {
                h2 >>>= 7 & d2, d2 -= 7 & d2, a2.mode = Fe;
                break;
              }
              for (; d2 < 3; ) {
                if (0 === o2) break t;
                o2--, h2 += i2[s2++] << d2, d2 += 8;
              }
              switch (a2.last = 1 & h2, h2 >>>= 1, d2 -= 1, 3 & h2) {
                case 0:
                  a2.mode = 16193;
                  break;
                case 1:
                  if (Xe(a2), a2.mode = Oe, e2 === pe) {
                    h2 >>>= 2, d2 -= 2;
                    break t;
                  }
                  break;
                case 2:
                  a2.mode = 16196;
                  break;
                case 3:
                  t2.msg = "invalid block type", a2.mode = Le;
              }
              h2 >>>= 2, d2 -= 2;
              break;
            case 16193:
              for (h2 >>>= 7 & d2, d2 -= 7 & d2; d2 < 32; ) {
                if (0 === o2) break t;
                o2--, h2 += i2[s2++] << d2, d2 += 8;
              }
              if ((65535 & h2) != (h2 >>> 16 ^ 65535)) {
                t2.msg = "invalid stored block lengths", a2.mode = Le;
                break;
              }
              if (a2.length = 65535 & h2, h2 = 0, d2 = 0, a2.mode = Te, e2 === pe) break t;
            case Te:
              a2.mode = 16195;
            case 16195:
              if (c2 = a2.length, c2) {
                if (c2 > o2 && (c2 = o2), c2 > l2 && (c2 = l2), 0 === c2) break t;
                n2.set(i2.subarray(s2, s2 + c2), r2), o2 -= c2, s2 += c2, l2 -= c2, r2 += c2, a2.length -= c2;
                break;
              }
              a2.mode = Se;
              break;
            case 16196:
              for (; d2 < 14; ) {
                if (0 === o2) break t;
                o2--, h2 += i2[s2++] << d2, d2 += 8;
              }
              if (a2.nlen = 257 + (31 & h2), h2 >>>= 5, d2 -= 5, a2.ndist = 1 + (31 & h2), h2 >>>= 5, d2 -= 5, a2.ncode = 4 + (15 & h2), h2 >>>= 4, d2 -= 4, a2.nlen > 286 || a2.ndist > 30) {
                t2.msg = "too many length or distance symbols", a2.mode = Le;
                break;
              }
              a2.have = 0, a2.mode = 16197;
            case 16197:
              for (; a2.have < a2.ncode; ) {
                for (; d2 < 3; ) {
                  if (0 === o2) break t;
                  o2--, h2 += i2[s2++] << d2, d2 += 8;
                }
                a2.lens[Z2[a2.have++]] = 7 & h2, h2 >>>= 3, d2 -= 3;
              }
              for (; a2.have < 19; ) a2.lens[Z2[a2.have++]] = 0;
              if (a2.lencode = a2.lendyn, a2.lenbits = 7, E2 = { bits: a2.lenbits }, x2 = me(0, a2.lens, 0, 19, a2.lencode, 0, a2.work, E2), a2.lenbits = E2.bits, x2) {
                t2.msg = "invalid code lengths set", a2.mode = Le;
                break;
              }
              a2.have = 0, a2.mode = 16198;
            case 16198:
              for (; a2.have < a2.nlen + a2.ndist; ) {
                for (; z2 = a2.lencode[h2 & (1 << a2.lenbits) - 1], m2 = z2 >>> 24, b2 = z2 >>> 16 & 255, g2 = 65535 & z2, !(m2 <= d2); ) {
                  if (0 === o2) break t;
                  o2--, h2 += i2[s2++] << d2, d2 += 8;
                }
                if (g2 < 16) h2 >>>= m2, d2 -= m2, a2.lens[a2.have++] = g2;
                else {
                  if (16 === g2) {
                    for (R2 = m2 + 2; d2 < R2; ) {
                      if (0 === o2) break t;
                      o2--, h2 += i2[s2++] << d2, d2 += 8;
                    }
                    if (h2 >>>= m2, d2 -= m2, 0 === a2.have) {
                      t2.msg = "invalid bit length repeat", a2.mode = Le;
                      break;
                    }
                    y2 = a2.lens[a2.have - 1], c2 = 3 + (3 & h2), h2 >>>= 2, d2 -= 2;
                  } else if (17 === g2) {
                    for (R2 = m2 + 3; d2 < R2; ) {
                      if (0 === o2) break t;
                      o2--, h2 += i2[s2++] << d2, d2 += 8;
                    }
                    h2 >>>= m2, d2 -= m2, y2 = 0, c2 = 3 + (7 & h2), h2 >>>= 3, d2 -= 3;
                  } else {
                    for (R2 = m2 + 7; d2 < R2; ) {
                      if (0 === o2) break t;
                      o2--, h2 += i2[s2++] << d2, d2 += 8;
                    }
                    h2 >>>= m2, d2 -= m2, y2 = 0, c2 = 11 + (127 & h2), h2 >>>= 7, d2 -= 7;
                  }
                  if (a2.have + c2 > a2.nlen + a2.ndist) {
                    t2.msg = "invalid bit length repeat", a2.mode = Le;
                    break;
                  }
                  for (; c2--; ) a2.lens[a2.have++] = y2;
                }
              }
              if (a2.mode === Le) break;
              if (0 === a2.lens[256]) {
                t2.msg = "invalid code -- missing end-of-block", a2.mode = Le;
                break;
              }
              if (a2.lenbits = 9, E2 = { bits: a2.lenbits }, x2 = me(1, a2.lens, 0, a2.nlen, a2.lencode, 0, a2.work, E2), a2.lenbits = E2.bits, x2) {
                t2.msg = "invalid literal/lengths set", a2.mode = Le;
                break;
              }
              if (a2.distbits = 6, a2.distcode = a2.distdyn, E2 = { bits: a2.distbits }, x2 = me(2, a2.lens, a2.nlen, a2.ndist, a2.distcode, 0, a2.work, E2), a2.distbits = E2.bits, x2) {
                t2.msg = "invalid distances set", a2.mode = Le;
                break;
              }
              if (a2.mode = Oe, e2 === pe) break t;
            case Oe:
              a2.mode = Ie;
            case Ie:
              if (o2 >= 6 && l2 >= 258) {
                t2.next_out = r2, t2.avail_out = l2, t2.next_in = s2, t2.avail_in = o2, a2.hold = h2, a2.bits = d2, de(t2, f2), r2 = t2.next_out, n2 = t2.output, l2 = t2.avail_out, s2 = t2.next_in, i2 = t2.input, o2 = t2.avail_in, h2 = a2.hold, d2 = a2.bits, a2.mode === Se && (a2.back = -1);
                break;
              }
              for (a2.back = 0; z2 = a2.lencode[h2 & (1 << a2.lenbits) - 1], m2 = z2 >>> 24, b2 = z2 >>> 16 & 255, g2 = 65535 & z2, !(m2 <= d2); ) {
                if (0 === o2) break t;
                o2--, h2 += i2[s2++] << d2, d2 += 8;
              }
              if (b2 && 0 == (240 & b2)) {
                for (p2 = m2, k2 = b2, v2 = g2; z2 = a2.lencode[v2 + ((h2 & (1 << p2 + k2) - 1) >> p2)], m2 = z2 >>> 24, b2 = z2 >>> 16 & 255, g2 = 65535 & z2, !(p2 + m2 <= d2); ) {
                  if (0 === o2) break t;
                  o2--, h2 += i2[s2++] << d2, d2 += 8;
                }
                h2 >>>= p2, d2 -= p2, a2.back += p2;
              }
              if (h2 >>>= m2, d2 -= m2, a2.back += m2, a2.length = g2, 0 === b2) {
                a2.mode = 16205;
                break;
              }
              if (32 & b2) {
                a2.back = -1, a2.mode = Se;
                break;
              }
              if (64 & b2) {
                t2.msg = "invalid literal/length code", a2.mode = Le;
                break;
              }
              a2.extra = 15 & b2, a2.mode = 16201;
            case 16201:
              if (a2.extra) {
                for (R2 = a2.extra; d2 < R2; ) {
                  if (0 === o2) break t;
                  o2--, h2 += i2[s2++] << d2, d2 += 8;
                }
                a2.length += h2 & (1 << a2.extra) - 1, h2 >>>= a2.extra, d2 -= a2.extra, a2.back += a2.extra;
              }
              a2.was = a2.length, a2.mode = 16202;
            case 16202:
              for (; z2 = a2.distcode[h2 & (1 << a2.distbits) - 1], m2 = z2 >>> 24, b2 = z2 >>> 16 & 255, g2 = 65535 & z2, !(m2 <= d2); ) {
                if (0 === o2) break t;
                o2--, h2 += i2[s2++] << d2, d2 += 8;
              }
              if (0 == (240 & b2)) {
                for (p2 = m2, k2 = b2, v2 = g2; z2 = a2.distcode[v2 + ((h2 & (1 << p2 + k2) - 1) >> p2)], m2 = z2 >>> 24, b2 = z2 >>> 16 & 255, g2 = 65535 & z2, !(p2 + m2 <= d2); ) {
                  if (0 === o2) break t;
                  o2--, h2 += i2[s2++] << d2, d2 += 8;
                }
                h2 >>>= p2, d2 -= p2, a2.back += p2;
              }
              if (h2 >>>= m2, d2 -= m2, a2.back += m2, 64 & b2) {
                t2.msg = "invalid distance code", a2.mode = Le;
                break;
              }
              a2.offset = g2, a2.extra = 15 & b2, a2.mode = 16203;
            case 16203:
              if (a2.extra) {
                for (R2 = a2.extra; d2 < R2; ) {
                  if (0 === o2) break t;
                  o2--, h2 += i2[s2++] << d2, d2 += 8;
                }
                a2.offset += h2 & (1 << a2.extra) - 1, h2 >>>= a2.extra, d2 -= a2.extra, a2.back += a2.extra;
              }
              if (a2.offset > a2.dmax) {
                t2.msg = "invalid distance too far back", a2.mode = Le;
                break;
              }
              a2.mode = 16204;
            case 16204:
              if (0 === l2) break t;
              if (c2 = f2 - l2, a2.offset > c2) {
                if (c2 = a2.offset - c2, c2 > a2.whave && a2.sane) {
                  t2.msg = "invalid distance too far back", a2.mode = Le;
                  break;
                }
                c2 > a2.wnext ? (c2 -= a2.wnext, u2 = a2.wsize - c2) : u2 = a2.wnext - c2, c2 > a2.length && (c2 = a2.length), w2 = a2.window;
              } else w2 = n2, u2 = r2 - a2.offset, c2 = a2.length;
              c2 > l2 && (c2 = l2), l2 -= c2, a2.length -= c2;
              do {
                n2[r2++] = w2[u2++];
              } while (--c2);
              0 === a2.length && (a2.mode = Ie);
              break;
            case 16205:
              if (0 === l2) break t;
              n2[r2++] = a2.length, l2--, a2.mode = Ie;
              break;
            case Fe:
              if (a2.wrap) {
                for (; d2 < 32; ) {
                  if (0 === o2) break t;
                  o2--, h2 |= i2[s2++] << d2, d2 += 8;
                }
                if (f2 -= l2, t2.total_out += f2, a2.total += f2, 4 & a2.wrap && f2 && (t2.adler = a2.check = a2.flags ? H(a2.check, n2, f2, r2 - f2) : C(a2.check, n2, f2, r2 - f2)), f2 = l2, 4 & a2.wrap && (a2.flags ? h2 : Ne(h2)) !== a2.check) {
                  t2.msg = "incorrect data check", a2.mode = Le;
                  break;
                }
                h2 = 0, d2 = 0;
              }
              a2.mode = 16207;
            case 16207:
              if (a2.wrap && a2.flags) {
                for (; d2 < 32; ) {
                  if (0 === o2) break t;
                  o2--, h2 += i2[s2++] << d2, d2 += 8;
                }
                if (4 & a2.wrap && h2 !== (4294967295 & a2.total)) {
                  t2.msg = "incorrect length check", a2.mode = Le;
                  break;
                }
                h2 = 0, d2 = 0;
              }
              a2.mode = 16208;
            case 16208:
              x2 = ve;
              break t;
            case Le:
              x2 = ze;
              break t;
            case 16210:
              return Ae;
            default:
              return xe;
          }
          return t2.next_out = r2, t2.avail_out = l2, t2.next_in = s2, t2.avail_in = o2, a2.hold = h2, a2.bits = d2, (a2.wsize || f2 !== t2.avail_out && a2.mode < Le && (a2.mode < Fe || e2 !== be)) && We(t2, t2.output, t2.next_out, f2 - t2.avail_out), _2 -= t2.avail_in, f2 -= t2.avail_out, t2.total_in += _2, t2.total_out += f2, a2.total += f2, 4 & a2.wrap && f2 && (t2.adler = a2.check = a2.flags ? H(a2.check, n2, f2, t2.next_out - f2) : C(a2.check, n2, f2, t2.next_out - f2)), t2.data_type = a2.bits + (a2.last ? 64 : 0) + (a2.mode === Se ? 128 : 0) + (a2.mode === Oe || a2.mode === Te ? 256 : 0), (0 === _2 && 0 === f2 || e2 === be) && x2 === ke && (x2 = Ee), x2;
        }, inflateEnd: (t2) => {
          if (Ce(t2)) return xe;
          let e2 = t2.state;
          return e2.window && (e2.window = null), t2.state = null, ke;
        }, inflateGetHeader: (t2, e2) => {
          if (Ce(t2)) return xe;
          const a2 = t2.state;
          return 0 == (2 & a2.wrap) ? xe : (a2.head = e2, e2.done = false, ke);
        }, inflateSetDictionary: (t2, e2) => {
          const a2 = e2.length;
          let i2, n2, s2;
          return Ce(t2) ? xe : (i2 = t2.state, 0 !== i2.wrap && i2.mode !== Ue ? xe : i2.mode === Ue && (n2 = 1, n2 = C(n2, e2, a2, 0), n2 !== i2.check) ? ze : (s2 = We(t2, e2, a2, a2), s2 ? (i2.mode = 16210, Ae) : (i2.havedict = 1, ke)));
        }, inflateInfo: "pako inflate (from Nodeca project)" };
        var Je = function() {
          this.text = 0, this.time = 0, this.xflags = 0, this.os = 0, this.extra = null, this.extra_len = 0, this.name = "", this.comment = "", this.hcrc = 0, this.done = false;
        };
        const Qe = Object.prototype.toString, { Z_NO_FLUSH: Ve, Z_FINISH: $e, Z_OK: ta, Z_STREAM_END: ea, Z_NEED_DICT: aa, Z_STREAM_ERROR: ia, Z_DATA_ERROR: na, Z_MEM_ERROR: sa } = K;
        function ra(t2) {
          this.options = jt({ chunkSize: 65536, windowBits: 15, to: "" }, t2 || {});
          const e2 = this.options;
          e2.raw && e2.windowBits >= 0 && e2.windowBits < 16 && (e2.windowBits = -e2.windowBits, 0 === e2.windowBits && (e2.windowBits = -15)), !(e2.windowBits >= 0 && e2.windowBits < 16) || t2 && t2.windowBits || (e2.windowBits += 32), e2.windowBits > 15 && e2.windowBits < 48 && 0 == (15 & e2.windowBits) && (e2.windowBits |= 15), this.err = 0, this.msg = "", this.ended = false, this.chunks = [], this.strm = new qt(), this.strm.avail_out = 0;
          let a2 = qe.inflateInit2(this.strm, e2.windowBits);
          if (a2 !== ta) throw new Error(j[a2]);
          if (this.header = new Je(), qe.inflateGetHeader(this.strm, this.header), e2.dictionary && ("string" == typeof e2.dictionary ? e2.dictionary = Gt(e2.dictionary) : "[object ArrayBuffer]" === Qe.call(e2.dictionary) && (e2.dictionary = new Uint8Array(e2.dictionary)), e2.raw && (a2 = qe.inflateSetDictionary(this.strm, e2.dictionary), a2 !== ta))) throw new Error(j[a2]);
        }
        function oa(t2, e2) {
          const a2 = new ra(e2);
          if (a2.push(t2), a2.err) throw a2.msg || j[a2.err];
          return a2.result;
        }
        ra.prototype.push = function(t2, e2) {
          const a2 = this.strm, i2 = this.options.chunkSize, n2 = this.options.dictionary;
          let s2, r2, o2;
          if (this.ended) return false;
          for (r2 = e2 === ~~e2 ? e2 : true === e2 ? $e : Ve, "[object ArrayBuffer]" === Qe.call(t2) ? a2.input = new Uint8Array(t2) : a2.input = t2, a2.next_in = 0, a2.avail_in = a2.input.length; ; ) {
            for (0 === a2.avail_out && (a2.output = new Uint8Array(i2), a2.next_out = 0, a2.avail_out = i2), s2 = qe.inflate(a2, r2), s2 === aa && n2 && (s2 = qe.inflateSetDictionary(a2, n2), s2 === ta ? s2 = qe.inflate(a2, r2) : s2 === na && (s2 = aa)); a2.avail_in > 0 && s2 === ea && a2.state.wrap > 0 && 0 !== t2[a2.next_in]; ) qe.inflateReset(a2), s2 = qe.inflate(a2, r2);
            switch (s2) {
              case ia:
              case na:
              case aa:
              case sa:
                return this.onEnd(s2), this.ended = true, false;
            }
            if (o2 = a2.avail_out, a2.next_out && (0 === a2.avail_out || s2 === ea)) if ("string" === this.options.to) {
              let t3 = Wt(a2.output, a2.next_out), e3 = a2.next_out - t3, n3 = Xt(a2.output, t3);
              a2.next_out = e3, a2.avail_out = i2 - e3, e3 && a2.output.set(a2.output.subarray(t3, t3 + e3), 0), this.onData(n3);
            } else this.onData(a2.output.length === a2.next_out ? a2.output : a2.output.subarray(0, a2.next_out));
            if (s2 !== ta || 0 !== o2) {
              if (s2 === ea) return s2 = qe.inflateEnd(this.strm), this.onEnd(s2), this.ended = true, true;
              if (0 === a2.avail_in) break;
            }
          }
          return true;
        }, ra.prototype.onData = function(t2) {
          this.chunks.push(t2);
        }, ra.prototype.onEnd = function(t2) {
          t2 === ta && ("string" === this.options.to ? this.result = this.chunks.join("") : this.result = Kt(this.chunks)), this.chunks = [], this.err = t2, this.msg = this.strm.msg;
        };
        var la = { Inflate: ra, inflate: oa, inflateRaw: function(t2, e2) {
          return (e2 = e2 || {}).raw = true, oa(t2, e2);
        }, ungzip: oa, constants: K };
        const { Deflate: ha, deflate: da, deflateRaw: _a, gzip: fa } = le, { Inflate: ca, inflate: ua, inflateRaw: wa, ungzip: ma } = la;
        var ba = ha, ga = da, pa = _a, ka = fa, va = ca, ya = ua, xa = wa, za = ma, Aa = K, Ea = { Deflate: ba, deflate: ga, deflateRaw: pa, gzip: ka, Inflate: va, inflate: ya, inflateRaw: xa, ungzip: za, constants: Aa };
        t.Deflate = ba, t.Inflate = va, t.constants = Aa, t.default = Ea, t.deflate = ga, t.deflateRaw = pa, t.gzip = ka, t.inflate = ya, t.inflateRaw = xa, t.ungzip = za, Object.defineProperty(t, "__esModule", { value: true });
      }));
    }
  });

  // ../../../../websites/Alldatalogs/apps/web/public/parse-worker.js
  var import_pako_min = __toESM(require_pako_min());

  // ../../../../websites/Alldatalogs/packages/datalog-core/browser/entry.ts
  var entry_exports = {};
  __export(entry_exports, {
    HALTECH_TYPES: () => HALTECH_TYPES,
    HPL_PID_NAMES: () => HPL_PID_NAMES,
    bucketDecimate: () => bucketDecimate,
    convertHolleyDlToCsv: () => convertHolleyDlToCsv,
    convertHplToCsv: () => convertHplToCsv,
    convertLdToCsv: () => convertLdToCsv,
    isHaltechCsv: () => isHaltechCsv,
    parseDatalogCsv: () => parseDatalogCsv,
    parseHaltechCsv: () => parseHaltechCsv
  });

  // ../../../../websites/Alldatalogs/packages/datalog-core/src/decimate.ts
  function bucketDecimate(rows, maxPoints) {
    if (maxPoints <= 0 || rows <= maxPoints) {
      return Array.from({ length: rows }, (_, i) => i);
    }
    const indices = /* @__PURE__ */ new Set();
    for (let k = 0; k < maxPoints; k++) {
      indices.add(Math.min(rows - 1, Math.round(k * (rows - 1) / (maxPoints - 1))));
    }
    indices.add(0);
    indices.add(rows - 1);
    return Array.from(indices).sort((a, b) => a - b);
  }

  // ../../../../websites/Alldatalogs/packages/datalog-core/src/haltech/haltech-csv.ts
  var HALTECH_TYPES = {
    Angle: { div: 10, unit: "\xB0" },
    Pressure: { div: 10, unit: "kPa" },
    AbsPressure: { div: 10, unit: "kPa" },
    EngineSpeed: { div: 1, unit: "rpm" },
    Percentage: { div: 10, unit: "%" },
    Temperature: { div: 10, add: -273.15, unit: "\xB0C" },
    // 0.1 K
    BatteryVoltage: { div: 1e3, unit: "V" },
    Time_us: { div: 1e3, unit: "ms" },
    Time_ms_as_s: { div: 1e3, unit: "s" },
    AFR: { div: 1e3, unit: "\u03BB" },
    Speed: { div: 10, unit: "km/h" },
    Acceleration: { div: 1e3, unit: "g" },
    ShorterDistance: { div: 1e3, unit: "mm" },
    // µm
    DrivenDistance: { div: 1e3, unit: "km" },
    // m
    Ratio: { div: 1e3, unit: "" },
    AngularVelocity: { div: 10, unit: "\xB0/s" },
    Gear: { div: 1, unit: "" },
    Position: { div: 1, unit: "" },
    Flow: { div: 1, unit: "" },
    Raw: { div: 1, unit: "" }
  };
  function isHaltechCsv(text) {
    return /^﻿?\s*%DataLog%/.test(text.slice(0, 32));
  }
  var TIME_RE = /^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;
  function wallClockSeconds(cell) {
    const m = TIME_RE.exec(cell);
    if (!m) return NaN;
    const frac = m[4] ? Number("0." + m[4]) : 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
  }
  function parseHaltechCsv(text) {
    const warnings = [];
    const lines = text.split(/\r\n|\r|\n/);
    if (lines.length > 0 && lines[0].charCodeAt(0) === 65279) lines[0] = lines[0].slice(1);
    const chans = [];
    let cur = null;
    let dataStart = -1;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const comma = line.indexOf(",");
      if (TIME_RE.test(comma === -1 ? line : line.slice(0, comma))) {
        dataStart = i;
        break;
      }
      const sep = line.indexOf(" : ");
      if (sep === -1) continue;
      const key = line.slice(0, sep).trim();
      const val = line.slice(sep + 3).trim();
      if (key === "Channel") {
        cur = { name: val, id: 0, type: "Raw" };
        chans.push(cur);
      } else if (cur && key === "ID") cur.id = parseInt(val, 10) || 0;
      else if (cur && key === "Type") cur.type = val;
    }
    if (!chans.length) throw new Error('Haltech CSV: no "Channel :" blocks found in the header.');
    if (dataStart === -1) throw new Error("Haltech CSV: no data rows found after the header.");
    const keep = [];
    chans.forEach((c, i) => {
      if (c.name === "Unknown" && c.id === 0) {
        warnings.push({ code: "haltech_unknown_dropped", message: 'Dropped an "Unknown" placeholder column', channel: `column ${i + 2}` });
        return;
      }
      keep.push(i);
    });
    const seen = {};
    const channelNames = keep.map((i) => {
      const n2 = chans[i].name;
      seen[n2] = (seen[n2] || 0) + 1;
      if (seen[n2] > 1) {
        warnings.push({ code: "dup_channel", message: "Duplicate channel name renamed", channel: n2 });
        return `${n2} (${seen[n2]})`;
      }
      return n2;
    });
    const scales = keep.map((i) => {
      const t = HALTECH_TYPES[chans[i].type];
      if (!t) warnings.push({ code: "haltech_unknown_type", message: `Unknown Haltech channel type "${chans[i].type}"; values kept raw`, channel: chans[i].name });
      return t || { div: 1, unit: "" };
    });
    const units = scales.map((s) => s.unit);
    const n = keep.length;
    const time = [];
    const series = Array.from({ length: n }, () => []);
    const last = new Float64Array(n).fill(NaN);
    let t0 = NaN, prevT = NaN, dayOffset = 0, skipped = 0;
    for (let i = dataStart; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const cells = line.split(",");
      const wall = wallClockSeconds(cells[0].trim());
      if (!isFinite(wall)) {
        skipped++;
        continue;
      }
      if (isNaN(t0)) t0 = wall;
      if (isFinite(prevT) && wall + dayOffset - t0 < prevT - 3600) dayOffset += 86400;
      let t = wall + dayOffset - t0;
      if (isFinite(prevT) && t < prevT) t = prevT;
      prevT = t;
      time.push(t);
      for (let k = 0; k < n; k++) {
        const cell = cells[keep[k] + 1];
        let v = last[k];
        if (cell !== void 0 && cell !== "") {
          const raw = Number(cell);
          if (!isNaN(raw)) {
            const s = scales[k];
            v = raw / s.div + (s.add || 0);
            last[k] = v;
          }
        }
        series[k].push(v);
      }
    }
    if (!time.length) throw new Error("Haltech CSV: no data rows could be read.");
    if (skipped) warnings.push({ code: "haltech_rows_skipped", message: `Skipped ${skipped} row(s) without a time stamp` });
    return { channelNames, units, time, series, textLevels: {}, channelIds: null, warnings };
  }

  // ../../../../websites/Alldatalogs/packages/datalog-core/src/megasquirt/msl.ts
  function isMlvlgBinary(head) {
    return head.slice(0, 5) === "MLVLG";
  }
  var HEADER_RE = /^"?\s*Time\s*"?\t/i;
  function isMegaSquirtLog(text) {
    const head = text.slice(0, 4096);
    if (isMlvlgBinary(head)) return true;
    const lines = head.split(/\r\n|\r|\n/, 12);
    if (!lines.length) return false;
    const first = lines[0].replace(/^﻿/, "");
    const quotedStart = first.charAt(0) === '"';
    const captureLine = lines.slice(0, 4).some((l) => /^"?\s*Capture Date:/i.test(l));
    if (!quotedStart && !captureLine) return false;
    return lines.some((l) => HEADER_RE.test(l));
  }
  function csvCell(cell) {
    const s = cell.trim();
    return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function megaSquirtToCsv(text) {
    if (isMlvlgBinary(text.slice(0, 8))) {
      throw new Error("This .mlg is MegaLogViewer's binary log. Open it in MegaLogViewer or TunerStudio and save it as a .msl text log, then open that.");
    }
    const lines = text.split(/\r\n|\r|\n/);
    if (lines.length && lines[0].charCodeAt(0) === 65279) lines[0] = lines[0].slice(1);
    let h = -1;
    for (let i = 0; i < lines.length && i < 64; i++) {
      if (HEADER_RE.test(lines[i])) {
        h = i;
        break;
      }
    }
    if (h === -1) throw new Error('MegaSquirt log: no TAB-separated "Time" header row found.');
    const out = [];
    for (let i = h; i < lines.length; i++) {
      const line = lines[i];
      if (i > h + 1 && !line.trim()) continue;
      if (line.charAt(0) === "#" && i > h + 1) continue;
      out.push(line.split("	").map(csvCell).join(","));
    }
    return out.join("\n");
  }

  // ../../../../websites/Alldatalogs/packages/datalog-core/src/importers/csv.ts
  function splitCsvLine(line, parenAware) {
    const hasQuote = line.indexOf('"') !== -1;
    const hasParen = parenAware && line.indexOf("(") !== -1;
    if (!hasQuote && !hasParen) return line.split(",");
    let honourQuotes = hasQuote;
    if (honourQuotes) {
      let nq = 0;
      for (let i = 0; i < line.length; i++) if (line.charCodeAt(i) === 34) nq++;
      if (nq % 2 !== 0) honourQuotes = false;
    }
    let honourParens = hasParen;
    if (honourParens) {
      let bal = 0;
      for (let i = 0; i < line.length && bal >= 0; i++) {
        const ch = line[i];
        if (ch === "(") bal++;
        else if (ch === ")") bal--;
      }
      if (bal !== 0) honourParens = false;
    }
    if (!honourQuotes && !honourParens) return line.split(",");
    const out = [];
    let cur = "";
    let inQ = false;
    let depth = 0;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        cur += ch;
        if (ch === '"') inQ = false;
        continue;
      }
      if (ch === '"' && honourQuotes && cur.trim() === "") {
        inQ = true;
        cur += ch;
        continue;
      }
      if (honourParens) {
        if (ch === "(") depth++;
        else if (ch === ")" && depth > 0) depth--;
      }
      if (ch === "," && depth === 0) {
        out.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    out.push(cur);
    return out;
  }
  function unquote(s) {
    const t = s.trim();
    if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') return t.slice(1, -1).replace(/""/g, '"');
    return t;
  }
  var NAN_SPELLINGS = /^(?:[+-]?nan(?:\(ind\))?|[+-]?inf(?:inity)?|#div\/0!|#n\/a|n\/a|null|--)$/i;
  function parseDatalogCsv(text) {
    if (isHaltechCsv(text)) return parseHaltechCsv(text);
    if (isMegaSquirtLog(text)) text = megaSquirtToCsv(text);
    const warnings = [];
    const lines = text.split(/\r\n|\r|\n/);
    if (lines.length > 0 && lines[0].charCodeAt(0) === 65279) lines[0] = lines[0].slice(1);
    if (/^\s*"?\s*point number\s*"?\s*,\s*"?\s*rtc\s*"?/i.test(lines[0] || "")) {
      for (let i = 0; i < lines.length; i++) {
        const k = lines[i].indexOf(",");
        lines[i] = k >= 0 ? lines[i].slice(k + 1) : lines[i];
      }
      const k0 = lines[0].indexOf(",");
      lines[0] = "Offset" + (k0 >= 0 ? lines[0].slice(k0) : "");
      if (lines.length > 1) lines[1] = lines[1].replace(/[[\]]/g, "");
    }
    let namesLine;
    let unitsLine;
    let dataStart = -1;
    let namesIdx = -1;
    const markerIdx = lines.findIndex((l) => l.trim().toLowerCase() === "[channel data]");
    if (markerIdx !== -1) {
      let j = markerIdx - 1;
      while (j >= 0 && lines[j].trim() === "") j--;
      unitsLine = lines[j];
      j--;
      while (j >= 0 && lines[j].trim() === "") j--;
      namesLine = lines[j];
      namesIdx = j;
      dataStart = markerIdx + 1;
      while (dataStart < lines.length && lines[dataStart].trim() === "") dataStart++;
    } else {
      let headerIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (/^"?\s*(time|offset)\b[^,]*,/i.test(lines[i])) {
          headerIdx = i;
          break;
        }
      }
      if (headerIdx !== -1) {
        namesLine = lines[headerIdx];
        namesIdx = headerIdx;
        const probeCells = splitCsvLine(lines[headerIdx + 1] || "", false);
        const probeSecond = probeCells.length > 1 ? parseFloat(unquote(probeCells[1])) : NaN;
        if (probeCells.length > 1 && !isFinite(probeSecond)) {
          unitsLine = lines[headerIdx + 1];
          dataStart = headerIdx + 2;
        } else {
          unitsLine = "";
          dataStart = headerIdx + 1;
        }
        while (dataStart < lines.length && lines[dataStart].trim() === "") dataStart++;
      }
    }
    if (namesLine === void 0 || dataStart === -1) {
      throw new Error(
        `This doesn't look like a supported datalog CSV (no "[Channel Data]" section or "time,..."/"offset,..." header row found).`
      );
    }
    const stripSctMeta = (s) => {
      const bar = s.indexOf("|");
      return bar === -1 ? s : s.slice(0, bar).trim();
    };
    let dataCols = 0;
    for (let pc = dataStart; pc < lines.length && pc < dataStart + 5; pc++) {
      const probe = lines[pc].trim();
      if (!probe || probe.charAt(0) === "[" || probe.charAt(0) === "-" && probe.charAt(1) === "-") continue;
      const pn = splitCsvLine(probe, false).length;
      if (pn > dataCols) dataCols = pn;
    }
    let rawNames = splitCsvLine(namesLine, true);
    while (dataCols > 1 && rawNames.length > dataCols && rawNames[rawNames.length - 1].trim() === "") rawNames.pop();
    if (dataCols > 1 && rawNames.length > dataCols) {
      const headerCols = rawNames.length;
      const folded = rawNames.slice(dataCols - 1).join(",");
      rawNames = rawNames.slice(0, dataCols - 1).concat(folded);
      warnings.push({
        code: "header_fold",
        message: `Header has ${headerCols} names for ${dataCols} data columns; folded the last ${headerCols - dataCols + 1} into one channel name`,
        channel: unquote(folded)
      });
    }
    rawNames = rawNames.map((s) => stripSctMeta(unquote(s)));
    const seenNames = {};
    const allNames = rawNames.map((n) => {
      seenNames[n] = (seenNames[n] || 0) + 1;
      if (seenNames[n] > 1) {
        warnings.push({ code: "dup_channel", message: `Duplicate channel name renamed`, channel: n });
        return `${n} (${seenNames[n]})`;
      }
      return n;
    });
    const channelNames = allNames.slice(1);
    let rawUnits = splitCsvLine(unitsLine || "", true);
    if (dataCols > 1 && rawUnits.length > dataCols) {
      rawUnits = rawUnits.slice(0, dataCols - 1).concat(rawUnits.slice(dataCols - 1).join(","));
    }
    const units = rawUnits.map(unquote).slice(1);
    let allIds = null;
    let pidIdx = namesIdx - 1;
    while (pidIdx >= 0 && lines[pidIdx].trim() === "") pidIdx--;
    if (pidIdx >= 0 && lines[pidIdx].trim().charAt(0) !== "[") {
      const pidTokens = lines[pidIdx].split(",").map((s) => s.trim());
      const pidShape = pidTokens.every((s) => s === "" || /^\d+$/.test(s));
      const pidSeen = pidTokens[0] === "0" && pidTokens.slice(1).some((s) => s !== "");
      if (pidShape && pidSeen) {
        allIds = allNames.map((_, i) => {
          const s = i < pidTokens.length ? pidTokens[i] : "";
          if (s === "") return null;
          const id = parseInt(s, 10);
          return i > 0 && id === 0 ? null : id;
        });
      }
    }
    const numCols = allNames.length;
    const time = [];
    const series = Array.from({ length: numCols - 1 }, () => []);
    const dataRows = [];
    for (let i = dataStart; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line.startsWith("--") || line.startsWith("[")) break;
      dataRows.push(i);
    }
    const nonEmpty = Array.from({ length: numCols - 1 }, () => 0);
    const textCount = Array.from({ length: numCols - 1 }, () => 0);
    for (const i of dataRows) {
      const parts = splitCsvLine(lines[i].trim(), false);
      if (parts.length < numCols) continue;
      if (!isFinite(parseFloat(unquote(parts[0])))) continue;
      for (let c = 1; c < numCols; c++) {
        const raw = unquote(parts[c] || "");
        if (raw === "") continue;
        nonEmpty[c - 1]++;
        if (isNaN(Number(raw)) && !NAN_SPELLINGS.test(raw)) textCount[c - 1]++;
      }
    }
    const isText = textCount.map((n, k) => n * 2 > nonEmpty[k]);
    const levels = Array.from({ length: numCols - 1 }, () => []);
    const levelIndex = Array.from({ length: numCols - 1 }, () => ({}));
    const strayCount = Array.from({ length: numCols - 1 }, () => 0);
    const strayExample = Array.from({ length: numCols - 1 }, () => "");
    for (const i of dataRows) {
      const parts = splitCsvLine(lines[i].trim(), false);
      if (parts.length < numCols) continue;
      const t = parseFloat(unquote(parts[0]));
      if (!isFinite(t)) continue;
      time.push(t);
      for (let c = 1; c < numCols; c++) {
        const k = c - 1;
        const raw = unquote(parts[c] || "");
        if (raw === "") {
          series[k].push(NaN);
          continue;
        }
        if (isText[k]) {
          const key = "#" + raw;
          let idx = levelIndex[k][key];
          if (idx === void 0) {
            idx = levels[k].length;
            levelIndex[k][key] = idx;
            levels[k].push(raw);
          }
          series[k].push(idx);
        } else {
          const v = Number(raw);
          if (isNaN(v)) {
            if (!NAN_SPELLINGS.test(raw)) {
              strayCount[k]++;
              if (strayCount[k] === 1) strayExample[k] = raw;
            }
            series[k].push(NaN);
          } else {
            series[k].push(isFinite(v) && Math.abs(v) < 1e300 ? v : NaN);
          }
        }
      }
    }
    if (time.length === 0) throw new Error("No data rows found in this file.");
    const keepIdx = [];
    for (let c = 0; c < channelNames.length; c++) {
      if (series[c].some((v) => isFinite(v))) keepIdx.push(c);
      else warnings.push({ code: "empty_channel", message: "Channel has no data", channel: channelNames[c] });
    }
    for (const c of keepIdx) {
      if (strayCount[c] > 0) {
        warnings.push({
          code: "non_numeric_cell",
          message: `${strayCount[c]} non-numeric cell(s) treated as missing (e.g. "${strayExample[c]}")`,
          channel: channelNames[c]
        });
      }
    }
    const textLevels = {};
    for (const c of keepIdx) {
      if (isText[c]) textLevels[channelNames[c]] = levels[c];
    }
    const ids = allIds;
    const channelIds = ids === null ? null : [ids[0] ?? null, ...keepIdx.map((c) => ids[c + 1] ?? null)];
    return {
      channelNames: keepIdx.map((c) => channelNames[c]),
      units: keepIdx.map((c) => units[c] || ""),
      time,
      series: keepIdx.map((c) => series[c]),
      textLevels,
      channelIds,
      warnings
    };
  }

  // ../../../../websites/Alldatalogs/packages/datalog-core/src/hpl/hpl-to-csv.ts
  var HPL_PID_NAMES = {
    3: "Fuel System #1 Status (SAE)",
    5: "Engine Coolant Temp (SAE)",
    6: "Short Term Fuel Trim Bank 1 (SAE)",
    7: "Long Term Fuel Trim Bank 1 (SAE)",
    8: "Short Term Fuel Trim Bank 2 (SAE)",
    9: "Long Term Fuel Trim Bank 2 (SAE)",
    10: "Fuel Pressure (SAE)",
    11: "Intake Manifold Absolute Pressure (SAE)",
    12: "Engine RPM (SAE)",
    13: "Vehicle Speed (SAE)",
    14: "Timing Advance (SAE)",
    15: "Intake Air Temp (SAE)",
    16: "Mass Airflow (SAE)",
    17: "Throttle Position (SAE)",
    35: "Fuel Rail Pressure (SAE)",
    47: "Fuel Level Input (SAE)",
    51: "Barometric Pressure (SAE)",
    52: "WB EQ Ratio 1 (SAE)",
    56: "WB EQ Ratio 5 (SAE)",
    66: "Control Module Voltage (SAE)",
    67: "Absolute Load (SAE)",
    68: "Equivalence Ratio Commanded (SAE)",
    69: "Relative Throttle Position (SAE)",
    70: "Ambient Air Temp (SAE)",
    73: "Accelerator Position D (SAE)",
    76: "Commanded Throttle Actuator (SAE)",
    403: "Relative Throttle Position A (SAE)",
    404: "Relative Throttle Position B (SAE)",
    2100: "Control Module Voltage",
    2111: "Throttle Position",
    2114: "Accelerator Pedal Position",
    2118: "Accelerator Pedal Position Sensor 1",
    2119: "Accelerator Pedal Position Sensor 2",
    2120: "Engine Oil Pressure",
    2124: "Engine Coolant Temp",
    2125: "Ambient Air Temp",
    2127: "Intake Air Temp",
    2135: "Engine RPM",
    2161: "Throttle Desired Angle",
    2165: "Cylinder Head Temp",
    2170: "Intake Cam Des Angle",
    2172: "Intake Cam Angle",
    2173: "Intake Cam 2 Angle",
    2176: "Exhaust Cam Des Angle",
    2178: "Exhaust Cam Angle",
    2179: "Exhaust Cam 2 Angle",
    2182: "Intake Cam DC",
    2183: "Intake Cam 2 DC",
    2184: "Exhaust Cam DC",
    2185: "Exhaust Cam 2 DC",
    2210: "Idle Desired RPM",
    2240: "Idle Adapt (STIT)",
    2261: "Throttle Desired Angle (Flow Model)",
    2263: "Throttle Angle Predicted (TQ Control)",
    2300: "Mass Airflow",
    2323: "Air Load",
    2331: "Manifold Absolute Pressure",
    2340: "Barometric Pressure",
    2343: "Supercharger Inlet Pressure",
    2408: "MAP Maximum Achievable (Current Conditions)",
    2409: "Load Maximum Achievable (Current Conditions)",
    2418: "Load Maximum Calibrated (Current Conditions)",
    2500: "Timing Advance",
    2501: "Drive Mode Requested",
    2517: "Torque Mgt Advance",
    2630: "Knock Retard",
    2649: "Knock Correction (+Adv/-Ret)",
    2702: "Desired Brake Torque",
    4024: "Clutch A Temp",
    4025: "Clutch B Temp",
    4028: "Clutch A Slip",
    4029: "Clutch B Slip",
    4050: "Clutch A Pressure (Corrected)",
    4051: "Clutch B Pressure (Corrected)",
    4100: "Trans Fluid Temp",
    4110: "Trans Input Shaft RPM",
    4111: "Trans Output Shaft RPM",
    4112: "Trans Turbine RPM",
    4115: "Trans Input Shaft RPM B",
    4205: "Line Pressure Desired",
    4210: "Line Pressure",
    4254: "Shift Solenoid A Current",
    4255: "Shift Solenoid B Current",
    4256: "Shift Solenoid C Current",
    4257: "Shift Solenoid D Current",
    4258: "Shift Solenoid E Current",
    4260: "Shift Solenoid A Pressure",
    4261: "Shift Solenoid B Pressure",
    4262: "Shift Solenoid C Pressure",
    4263: "Shift Solenoid D Pressure",
    4264: "Shift Solenoid E Pressure",
    4265: "Shift Solenoid F Pressure",
    4267: "Line Pressure Solenoid Current",
    4268: "Shift Solenoid F Current",
    4311: "TCC Slip",
    4313: "TCC Desired Slip",
    4340: "TCC Line Pressure",
    4353: "Mass Airflow Period",
    6005: "Equivalence Ratio Commanded - Bank 1",
    6160: "WB EQ Ratio Bank 1",
    6161: "WB EQ Ratio Bank 2",
    6202: "Injector Pulse Width Cyl 1",
    6304: "Short Term Fuel Trim Bank 1",
    6305: "Long Term Fuel Trim Bank 1",
    6306: "Short Term Fuel Trim Bank 2",
    6307: "Long Term Fuel Trim Bank 2",
    6376: "PFI Injector Maximum Pulse",
    6403: "Fuel Tank Level",
    6506: "Fuel Pump Commanded DC",
    6509: "Fuel Flow Rate",
    6586: "Fuel Pump Actual",
    6629: "Fuel Rail Temperature",
    7282: "Battery Voltage",
    7375: "Fuel Rail Pressure Sensor",
    7447: "TCC Speed Ratio",
    8e3: "Vehicle Speed",
    8022: "Torque Airlimit Source",
    8023: "DI/PI Blend Mode",
    8024: "DI/PI Blend",
    9309: "Torque Max Source",
    9310: "Torque Max Protection Source",
    9311: "Fuel Lift Pump Pressure Desired",
    9312: "Fuel Lift Pump Pressure Actual",
    12145: "RPM Limit Source",
    12146: "Trans Protect RPM Limit Source",
    12147: "Trans Protect Group ID",
    12148: "Trans Protect RPM Limit",
    12149: "Engine Speed Limiting Source",
    12200: "Idle Speed Control Mode",
    12529: "Engine Indicated Torque Reference",
    12533: "Knock Octane Modifier",
    12700: "Torque Source",
    12861: "Fuel Cut",
    12993: "TR Command Spark Retard",
    12994: "TR Command Final",
    12998: "TR Authority Spark Clip",
    12999: "Burble Active",
    13017: "Desired Airmass Arbitration Source",
    13018: "Desired Airmass Arbitration Multiplier",
    13020: "Speed Limit Maximum (Hard Limit)",
    14100: "Trans Current Gear",
    14103: "Trans Commanded Gear",
    14211: "Shift Map Current",
    14212: "Shift Scheduling State",
    14213: "SST Mode",
    14214: "Shift Character Desired",
    14215: "Ratio Manager Driver Mode",
    14410: "TCC State Commanded",
    14411: "TCC State Actual",
    14412: "TCC Status",
    14524: "TCC Current",
    15021: "Fuel Rail Pressure Actual",
    15022: "Fuel Rail Pressure Desired",
    16204: "Fuel Pump",
    16205: "Fuel Pump Out Fail",
    17006: "Knock Cyl 1 (+Adv/-Ret)",
    17007: "Knock Cyl 2 (+Adv/-Ret)",
    17008: "Knock Cyl 3 (+Adv/-Ret)",
    17009: "Knock Cyl 4 (+Adv/-Ret)",
    17010: "Knock Cyl 5 (+Adv/-Ret)",
    17011: "Knock Cyl 6 (+Adv/-Ret)",
    17012: "Knock Cyl 7 (+Adv/-Ret)",
    17013: "Knock Cyl 8 (+Adv/-Ret)",
    19017: "Mapped Point 0 Weight",
    19018: "Mapped Point 1 Weight",
    19019: "Mapped Point 2 Weight",
    19020: "Mapped Point 3 Weight",
    19021: "Mapped Point 4 Weight",
    19022: "Mapped Point 5 Weight",
    19023: "Mapped Point 6 Weight",
    19024: "Mapped Point 7 Weight",
    19025: "Mapped Point 8 Weight",
    19026: "Mapped Point 9 Weight",
    19027: "Mapped Point 10 Weight",
    19028: "Mapped Point 11 Weight",
    19029: "Mapped Point 12 Weight",
    19030: "Mapped Point 13 Weight",
    19031: "Mapped Point 14 Weight",
    19032: "Mapped Point 15 Weight",
    19033: "Mapped Point 16 Weight",
    19034: "Mapped Point 17 Weight",
    19035: "Mapped Point 18 Weight",
    19036: "Mapped Point 19 Weight",
    19037: "Mapped Point 20 Weight",
    19038: "Mapped Point 21 Weight",
    19039: "Mapped Point 22 Weight",
    19040: "Mapped Point 23 Weight",
    19041: "Mapped Point 24 Weight",
    19042: "Mapped Point 25 Weight",
    19043: "Mapped Point 26 Weight",
    19044: "Mapped Point OP Weight",
    19045: "VCT Schedule Mode",
    19046: "Spark Source",
    19047: "Fuel Source",
    19048: "Driver Demand Limit Source",
    19049: "Idle Speed Source",
    19050: "Throttle Angle Source",
    19051: "VCT Distance to OP",
    19052: "VCT Number of Mapped Points",
    19053: "VCT Exhaust Cam Phase Angle",
    19054: "VCT Intake Cam Phase Angle",
    19055: "Manifold Charge Temp",
    19057: "Engine Brake Torque",
    19059: "ETC Torque Request",
    19063: "ETC FMEM Mode",
    19068: "Scheduled Torque",
    19073: "Borderline Modifier KOM",
    19074: "Borderline Knock",
    19076: "Desired Load",
    19077: "Desired Airmass"
  };
  var NID = 65536;
  function findChannelTableStart(buf, pos) {
    const known = pos - 5;
    for (let s = 0; s < known; s++) {
      let p = s;
      let count = 0;
      let ok = true;
      while (p < known) {
        if (p + 5 >= buf.length) {
          ok = false;
          break;
        }
        p += 5;
        const tag = buf[p];
        p += 1;
        if (tag !== 10 && tag !== 11) {
          ok = false;
          break;
        }
        p += 16;
        if (p >= buf.length) {
          ok = false;
          break;
        }
        const nl = buf[p];
        p += 1;
        if (nl < 0 || nl > 64 || p + nl > buf.length) {
          ok = false;
          break;
        }
        for (let j = p; j < p + nl; j++) {
          if (buf[j] < 32 || buf[j] > 126) {
            ok = false;
            break;
          }
        }
        if (!ok) break;
        p += nl;
        if (p >= buf.length) {
          ok = false;
          break;
        }
        const ul = buf[p];
        p += 1;
        if (ul >= 16) {
          ok = false;
          break;
        }
        p += ul;
        count++;
      }
      if (ok && p === known && count > 0) return s;
    }
    return known;
  }
  function dryParse(d, idWidth, valid, isEnum, tMax) {
    const n = d.length;
    let q = 2;
    let frames = 0;
    while (q + 4 <= n) {
      const t = d[q + 3];
      q += 4;
      if (t < 1 || t > tMax) return false;
      for (let u = 0; u < t; u++) {
        if (q + idWidth > n) return false;
        let id;
        let unchanged;
        if (idWidth === 1) {
          const b = d[q];
          q += 1;
          unchanged = b >= 128;
          id = unchanged ? b - 128 : b;
        } else {
          const b = d[q] | d[q + 1] << 8;
          q += 2;
          unchanged = (b & 32768) !== 0;
          id = unchanged ? b & 32767 : b;
        }
        if (!valid[id]) return false;
        if (!unchanged) {
          if (isEnum[id]) {
            if (q >= n) return false;
            const sl = d[q];
            q++;
            if (q + sl > n) return false;
            q += sl;
          } else {
            if (q + 8 > n) return false;
            q += 8;
          }
        }
      }
      frames++;
    }
    return frames > 0;
  }
  function asciiSlice(u8, start, end) {
    let s = "";
    for (let i = start; i < end; i++) s += String.fromCharCode(u8[i]);
    return s;
  }
  var utf8 = new TextDecoder("utf-8");
  function convertHplToCsv(input, inflateRaw, opts) {
    const o = opts || {};
    const periodMs = o.periodMs != null ? o.periodMs : 40;
    const interpolate = !!o.interpolate;
    const startOffsetSec = o.startOffsetSec != null ? o.startOffsetSec : 0;
    const usUnits = !!o.usUnits;
    const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (buf.length < 8 || buf[0] !== 72 || buf[1] !== 80 || buf[2] !== 84) {
      throw new Error("Not an HP Tuners .hpl file (missing 'HPT' signature).");
    }
    const version = buf[5];
    if (version === 7) {
      return convertV7(buf, { periodMs, interpolate, startOffsetSec, usUnits });
    }
    if (version !== 9) {
      throw new Error(
        `This log uses an older HP Tuners format (version ${version}) this viewer can't open directly. Open it in VCM Scanner and re-save it \u2014 the newer file (or a CSV export) will load here.`
      );
    }
    let pos = -1;
    for (let i = 0; i < 512 && i + 8 < buf.length; i++) {
      if (buf[i] === 10 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 7] === 240 && buf[i + 8] === 63) {
        pos = i;
        break;
      }
    }
    if (pos < 0) throw new Error("Could not locate channel table.");
    const valid = new Array(NID).fill(false);
    const isEnum = new Array(NID).fill(false);
    const name = new Array(NID).fill(null);
    const unit = new Array(NID).fill("");
    const pidOf = new Array(NID).fill(0);
    const order = [];
    let maxId = 0;
    let p = findChannelTableStart(buf, pos);
    while (true) {
      if (p + 5 >= buf.length) break;
      const id = dv.getUint16(p, true);
      const pid = dv.getUint16(p + 2, true);
      p += 5;
      const tag = buf[p];
      p += 1;
      p += 16;
      const nl = buf[p];
      p += 1;
      if (nl < 0 || nl > 64 || p + nl > buf.length) break;
      let ascii = true;
      for (let j = p; j < p + nl; j++) {
        if (buf[j] < 32 || buf[j] > 126) {
          ascii = false;
          break;
        }
      }
      if (!ascii) break;
      let nm = asciiSlice(buf, p, p + nl);
      if (!nm) nm = HPL_PID_NAMES[pid] || `Channel ${pid}`;
      p += nl;
      const ul = buf[p];
      p += 1;
      let un = "";
      if (ul > 0 && ul < 16) {
        un = utf8.decode(buf.subarray(p, p + ul));
        p += ul;
      } else if (ul >= 16) break;
      if (!valid[id]) {
        valid[id] = true;
        name[id] = nm;
        unit[id] = un;
        pidOf[id] = pid;
        isEnum[id] = tag === 11;
        order.push(id);
        if (id > maxId) maxId = id;
      }
    }
    const mul = new Float64Array(NID).fill(1);
    const add = new Float64Array(NID);
    const outUnit = new Array(NID).fill("");
    for (const id of order) {
      outUnit[id] = unit[id];
      if (usUnits) applyUsUnit(id, unit[id] || "", mul, add, outUnit);
    }
    const blockRanges = [];
    const blockTicks = [];
    let cutHeader = false;
    for (let i = 0; i + 4 <= buf.length; i++) {
      if (buf[i] === 67 && buf[i + 1] === 68 && buf[i + 2] === 71 && buf[i + 3] === 0) {
        if (i + 12 > buf.length) {
          cutHeader = true;
          break;
        }
        const clen = dv.getUint32(i + 4, true);
        blockRanges.push([i + 12, Math.min(i + 12 + clen, buf.length)]);
        const sy = i - 10;
        const hasSync = sy >= 0 && buf[sy] === 83 && buf[sy + 1] === 89 && buf[sy + 2] === 78 && buf[sy + 3] === 67;
        blockTicks.push(hasSync ? dv.getUint32(sy + 4, true) + dv.getUint16(sy + 8, true) * 4294967296 : null);
      }
    }
    const blocks = [];
    let truncated = cutHeader;
    for (const r of blockRanges) {
      let inflated = null;
      try {
        inflated = inflateRaw(buf.subarray(r[0], r[1]));
      } catch {
        inflated = null;
      }
      if (!inflated || inflated.length === 0) {
        truncated = true;
        break;
      }
      blocks.push(inflated);
    }
    const blocksSeen = blockRanges.length + (cutHeader ? 1 : 0);
    if (truncated && o.warnings) {
      o.warnings.push(
        `Log ends mid-block: ${blocks.length} of ${blocksSeen} data blocks read. The file looks truncated; the rows that could be decoded are shown.`
      );
    }
    if (blocks.length === 0) {
      throw new Error(
        truncated ? "This log is cut off before its first complete data block, so nothing can be decoded." : "No data blocks (CDG) found."
      );
    }
    const TICKS_PER_MS = 10;
    const baseTick = blockTicks.find((t) => t != null) ?? null;
    const tMax = order.length;
    let idWidth = maxId >= 128 ? 2 : 1;
    if (!dryParse(blocks[0], idWidth, valid, isEnum, tMax)) {
      const alt = idWidth === 1 ? 2 : 1;
      if (dryParse(blocks[0], alt, valid, isEnum, tMax)) idWidth = alt;
    }
    const sTime = new Array(NID);
    const sNum = new Array(NID);
    const sStr = new Array(NID);
    for (const id of order) {
      sTime[id] = [];
      if (isEnum[id]) sStr[id] = [];
      else sNum[id] = [];
    }
    const prevD = new Float64Array(NID);
    const prevS = new Array(NID);
    const hasPrev = new Array(NID).fill(false);
    const originMs = Math.round(startOffsetSec * 1e3);
    let blockStartMs = originMs;
    let maxMs = blockStartMs;
    for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
      const d = blocks[bIdx];
      const bt = blockTicks[bIdx];
      if (baseTick != null && bt != null) {
        blockStartMs = originMs + Math.round((bt - baseTick) / TICKS_PER_MS);
      }
      const ddv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const n = d.length;
      let q = 2;
      let baseC = 0;
      let prevC = -1;
      let firstC = -1;
      let lastUnwrap = 0;
      while (q + 4 <= n) {
        const c = d[q];
        const t = d[q + 3];
        q += 4;
        if (t < 1 || t > tMax) break;
        if (firstC < 0) {
          firstC = c;
          prevC = c;
        }
        if (c < prevC) baseC += 256;
        prevC = c;
        const unwrap = baseC + c - firstC;
        lastUnwrap = unwrap;
        const gms = blockStartMs + unwrap;
        let bad = false;
        for (let u = 0; u < t; u++) {
          if (q + idWidth > n) {
            bad = true;
            break;
          }
          let id;
          let unchanged;
          if (idWidth === 1) {
            const b = d[q];
            q += 1;
            unchanged = b >= 128;
            id = unchanged ? b - 128 : b;
          } else {
            const b = d[q] | d[q + 1] << 8;
            q += 2;
            unchanged = (b & 32768) !== 0;
            id = unchanged ? b & 32767 : b;
          }
          if (!valid[id]) {
            bad = true;
            break;
          }
          if (unchanged) {
            if (!hasPrev[id]) continue;
            sTime[id].push(gms);
            if (isEnum[id]) sStr[id].push(prevS[id]);
            else sNum[id].push(prevD[id]);
          } else {
            if (isEnum[id]) {
              if (q >= n) {
                bad = true;
                break;
              }
              const sl = d[q];
              q++;
              if (q + sl > n) {
                bad = true;
                break;
              }
              const sv = asciiSlice(d, q, q + sl);
              q += sl;
              prevS[id] = sv;
              hasPrev[id] = true;
              sTime[id].push(gms);
              sStr[id].push(sv);
            } else {
              if (q + 8 > n) {
                bad = true;
                break;
              }
              const dvv = ddv.getFloat64(q, true);
              q += 8;
              prevD[id] = dvv;
              hasPrev[id] = true;
              sTime[id].push(gms);
              sNum[id].push(dvv);
            }
          }
        }
        if (bad) break;
      }
      blockStartMs += lastUnwrap;
      if (blockStartMs > maxMs) maxMs = blockStartMs;
    }
    return emitCsv(
      { order, name, outUnit, isEnum, sTime, sNum, sStr, mul, add, maxMs, pid: pidOf },
      { periodMs, interpolate, startOffsetSec }
    );
  }
  function applyUsUnit(id, u, mul, add, outUnit) {
    const DEG = "\xB0";
    const MIDDOT = "\xB7";
    if (u === DEG + "C") {
      mul[id] = 1.8;
      add[id] = 32;
      outUnit[id] = DEG + "F";
    } else if (u === "km/h") {
      mul[id] = 0.6213711922;
      outUnit[id] = "mph";
    } else if (u === "kPa") {
      mul[id] = 0.1450377377;
      outUnit[id] = "psi";
    } else if (u === "MPa") {
      mul[id] = 145.0377377;
      outUnit[id] = "psi";
    } else if (u === "inHg") {
      mul[id] = 0.4911541474;
      outUnit[id] = "psi";
    } else if (u === "bar") {
      mul[id] = 14.503773773;
      outUnit[id] = "psi";
    } else if (u === "g/s") {
      mul[id] = 0.1322773573;
      outUnit[id] = "lb/min";
    } else if (u === "N m") {
      mul[id] = 0.7375621493;
      outUnit[id] = "lb" + MIDDOT + "ft";
    }
  }
  var V7_TAG_U8 = 2;
  var V7_TAG_F32 = 9;
  var V7_TAG_F64 = 10;
  var V7_TAG_STR = 11;
  function convertV7(buf, o) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const name = new Array(NID).fill(null);
    const unit = new Array(NID).fill("");
    const isEnum = new Array(NID).fill(false);
    const tag = new Uint8Array(NID);
    const scale = new Float64Array(NID).fill(1);
    const offset = new Float64Array(NID);
    const order = [];
    let p = 40;
    for (; ; ) {
      if (p + 24 >= buf.length) break;
      const id = dv.getUint16(p, true);
      p += 5;
      const tg = buf[p];
      p += 1;
      if (tg !== V7_TAG_U8 && tg !== V7_TAG_F32 && tg !== V7_TAG_F64 && tg !== V7_TAG_STR) {
        p -= 6;
        break;
      }
      const sc = dv.getFloat64(p, true);
      const off = dv.getFloat64(p + 8, true);
      p += 16;
      const nl = buf[p];
      p += 1;
      if (nl > 64 || p + nl > buf.length) {
        p -= 23;
        break;
      }
      let ascii = true;
      for (let j = p; j < p + nl; j++) {
        if (buf[j] < 32 || buf[j] > 126) {
          ascii = false;
          break;
        }
      }
      if (!ascii) {
        p -= 23;
        break;
      }
      const nm = asciiSlice(buf, p, p + nl);
      p += nl;
      const ul = buf[p];
      p += 1;
      if (ul >= 16) {
        p -= 24 + nl;
        break;
      }
      const un = ul ? utf8.decode(buf.subarray(p, p + ul)) : "";
      p += ul;
      if (name[id] == null) {
        name[id] = nm;
        unit[id] = un;
        tag[id] = tg;
        scale[id] = sc || 1;
        offset[id] = off;
        isEnum[id] = tg === V7_TAG_STR;
        order.push(id);
      }
    }
    if (order.length === 0) throw new Error("No channels found.");
    const tableEnd = p;
    const blocks = [];
    let start = tableEnd;
    for (let i = tableEnd; i + 4 <= buf.length; i++) {
      if (buf[i] === 115 && buf[i + 1] === 121 && buf[i + 2] === 110 && buf[i + 3] === 99) {
        blocks.push({ start, end: i });
        start = i + 9;
        i += 8;
      }
    }
    blocks.push({ start, end: buf.length });
    const sTime = new Array(NID);
    const sNum = new Array(NID);
    const sStr = new Array(NID);
    for (const id of order) {
      sTime[id] = [];
      if (isEnum[id]) sStr[id] = [];
      else sNum[id] = [];
    }
    const prevNum = new Float64Array(NID);
    const prevStr = new Array(NID);
    const hasPrev = new Array(NID).fill(false);
    let maxMs = 0;
    for (const blk of blocks) {
      let q = blk.start;
      while (q + 4 <= blk.end) {
        const ms = buf[q] | buf[q + 1] << 8 | buf[q + 2] << 16;
        const count = buf[q + 3];
        q += 4;
        if (count < 1 || count > order.length) break;
        let bad = false;
        for (let u = 0; u < count; u++) {
          if (q >= blk.end) {
            bad = true;
            break;
          }
          const b = buf[q];
          q += 1;
          const unchanged = b >= 128;
          const id = unchanged ? b - 128 : b;
          if (name[id] == null) {
            bad = true;
            break;
          }
          if (unchanged) {
            if (!hasPrev[id]) continue;
            sTime[id].push(ms);
            if (isEnum[id]) sStr[id].push(prevStr[id]);
            else sNum[id].push(prevNum[id]);
            if (ms > maxMs) maxMs = ms;
            continue;
          }
          if (isEnum[id]) {
            if (q >= blk.end) {
              bad = true;
              break;
            }
            const sl = buf[q];
            q += 1;
            if (q + sl > blk.end) {
              bad = true;
              break;
            }
            const sv = asciiSlice(buf, q, q + sl);
            q += sl;
            prevStr[id] = sv;
            hasPrev[id] = true;
            sTime[id].push(ms);
            sStr[id].push(sv);
          } else {
            let v;
            if (tag[id] === V7_TAG_U8) {
              if (q + 1 > blk.end) {
                bad = true;
                break;
              }
              v = buf[q] / scale[id] + offset[id];
              q += 1;
            } else if (tag[id] === V7_TAG_F64) {
              if (q + 8 > blk.end) {
                bad = true;
                break;
              }
              v = dv.getFloat64(q, true);
              q += 8;
            } else {
              if (q + 4 > blk.end) {
                bad = true;
                break;
              }
              v = dv.getFloat32(q, true);
              q += 4;
            }
            prevNum[id] = v;
            hasPrev[id] = true;
            sTime[id].push(ms);
            sNum[id].push(v);
          }
          if (ms > maxMs) maxMs = ms;
        }
        if (bad) break;
      }
    }
    let minMs = Infinity;
    for (const id of order) {
      const t = sTime[id];
      if (t.length && t[0] < minMs) minMs = t[0];
    }
    if (!isFinite(minMs)) throw new Error("No data rows found in this file.");
    for (const id of order) {
      const t = sTime[id];
      for (let i = 0; i < t.length; i++) t[i] = t[i] - minMs;
    }
    maxMs -= minMs;
    const mul = new Float64Array(NID).fill(1);
    const add = new Float64Array(NID);
    const outUnit = new Array(NID).fill("");
    for (const id of order) {
      outUnit[id] = unit[id] ?? "";
      if (o.usUnits) applyUsUnit(id, unit[id] || "", mul, add, outUnit);
    }
    return emitCsv(
      { order, name, outUnit, isEnum, sTime, sNum, sStr, mul, add, maxMs },
      { periodMs: o.periodMs, interpolate: o.interpolate, startOffsetSec: o.startOffsetSec }
    );
  }
  function emitCsv(d, o) {
    const { order, name, outUnit, isEnum, sTime, sNum, sStr, mul, add, maxMs } = d;
    const csvEsc = (s) => {
      if (s == null) return "";
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const fmtNum = (v) => {
      if (!isFinite(v)) return "";
      let s = v.toFixed(10);
      if (s.indexOf(".") >= 0) s = s.replace(/\.?0+$/, "");
      return s;
    };
    const fmtOffset = (sec) => {
      let s = sec.toFixed(3);
      if (s.indexOf(".") >= 0) s = s.replace(/\.?0+$/, "");
      return s;
    };
    const firstMs = Math.round(o.startOffsetSec * 1e3);
    const rows = Math.floor((maxMs - firstMs) / o.periodMs) + 1;
    const cur = new Int32Array(NID);
    const lines = [];
    const pid = d.pid;
    if (pid && order.some((id) => (pid[id] ?? 0) > 0)) {
      lines.push("0," + order.map((id) => (pid[id] ?? 0) > 0 ? String(pid[id]) : "").join(","));
    }
    lines.push("Offset," + order.map((id) => csvEsc(name[id])).join(","));
    lines.push("s," + order.map((id) => csvEsc(outUnit[id])).join(","));
    for (let r = 0; r < rows; r++) {
      const tms = firstMs + Math.floor(r * o.periodMs);
      const cells = [fmtOffset(tms / 1e3)];
      for (const id of order) {
        const ts = sTime[id];
        const m = ts.length;
        if (m === 0) {
          cells.push("");
          continue;
        }
        let ci = cur[id];
        while (ci + 1 < m && ts[ci + 1] <= tms) ci++;
        cur[id] = ci;
        if (isEnum[id]) {
          cells.push(csvEsc(sStr[id][ci]));
        } else {
          let v = sNum[id][ci];
          if (o.interpolate && ci + 1 < m && ts[ci] <= tms && ts[ci + 1] > tms) {
            const t0 = ts[ci];
            const t1 = ts[ci + 1];
            if (t1 !== t0) {
              const v1 = sNum[id][ci + 1];
              v = v + (v1 - v) * ((tms - t0) / (t1 - t0));
            }
          }
          cells.push(fmtNum(v * mul[id] + add[id]));
        }
      }
      lines.push(cells.join(","));
    }
    return lines.join("\n") + "\n";
  }

  // ../../../../websites/Alldatalogs/packages/datalog-core/src/motec/ld-to-csv.ts
  function convertLdToCsv(input, opts) {
    const o = opts || {};
    const outRate = o.outRateHz != null ? o.outRateHz : 200;
    const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (buf.length < 80 || buf[0] !== 64) throw new Error("Not a MoTeC .ld file.");
    const str = (off, n) => {
      let s = "";
      for (let i = off; i < off + n && i < buf.length; i++) {
        if (buf[i] === 0) break;
        s += String.fromCharCode(buf[i]);
      }
      return s.trim();
    };
    const device = str(76, 8);
    const date = str(94, 16);
    const time = str(126, 16);
    const driver = str(222, 32);
    const metaPtr = dv.getUint32(8, true);
    const chans = [];
    let p = metaPtr;
    let guard = 0;
    while (p !== 0 && p + 124 <= buf.length && guard++ < 2e3) {
      const next = dv.getUint32(p + 4, true);
      const ch = {
        dataAddr: dv.getUint32(p + 8, true),
        count: dv.getUint32(p + 12, true),
        dtA: dv.getUint16(p + 18, true),
        size: dv.getUint16(p + 20, true),
        freq: dv.getUint16(p + 22, true),
        name: str(p + 32, 32).replace(/\./g, " "),
        unit: str(p + 64, 12),
        isFloat: false,
        vals: new Float64Array(0),
        firstValid: 0
      };
      if (ch.size > 0 && ch.freq > 0 && ch.count > 0 && ch.name.length > 0) chans.push(ch);
      if (next === 0) break;
      p = next;
    }
    if (chans.length === 0) throw new Error("No channels found.");
    for (const ch of chans) {
      ch.isFloat = ch.dtA === 7;
      ch.vals = new Float64Array(ch.count);
      let good = ch.count;
      for (let i = 0; i < ch.count; i++) {
        const off = ch.dataAddr + i * ch.size;
        if (off + ch.size > buf.length) {
          good = i;
          break;
        }
        if (ch.dtA === 7 && ch.size === 4) ch.vals[i] = dv.getFloat32(off, true);
        else if (ch.size === 4) ch.vals[i] = dv.getInt32(off, true);
        else if (ch.size === 2) ch.vals[i] = dv.getInt16(off, true);
        else ch.vals[i] = buf[off];
      }
      ch.count = good;
      ch.firstValid = 0;
      if (ch.isFloat) {
        while (ch.firstValid < ch.count && ch.vals[ch.firstValid] === 0) ch.firstValid++;
      }
    }
    let maxT = 0;
    for (const ch of chans) {
      const tt = (ch.count - 1) / ch.freq;
      if (tt > maxT) maxT = tt;
    }
    const rows = Math.round(maxT * outRate) + 1;
    const dt = 1 / outRate;
    const q = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
    const fmt2 = (v) => {
      let s = v.toFixed(3);
      if (s.indexOf(".") >= 0) s = s.replace(/\.?0+$/, "");
      return s;
    };
    const out = [];
    out.push(q("Format") + "," + q("MoTeC CSV File"));
    out.push(q("Device") + "," + q(device));
    out.push(q("Driver") + "," + q(driver));
    out.push(q("Log Date") + "," + q(date));
    out.push(q("Log Time") + "," + q(time));
    out.push(q("Sample Rate") + "," + q(outRate.toFixed(3)) + "," + q("Hz"));
    out.push(q("Duration") + "," + q(maxT.toFixed(3)) + "," + q("s"));
    out.push("");
    out.push("");
    out.push(q("Time") + "," + chans.map((c) => q(c.name)).join(","));
    out.push(q("s") + "," + chans.map((c) => q(c.unit)).join(","));
    out.push("");
    const cells = new Array(chans.length + 1);
    for (let r = 0; r < rows; r++) {
      const t = r * dt;
      cells[0] = fmt2(t);
      for (let c = 0; c < chans.length; c++) {
        const ch = chans[c];
        const s = t * ch.freq;
        const i0 = Math.floor(s + 1e-9);
        if (i0 < ch.firstValid || i0 >= ch.count) {
          cells[c + 1] = "";
          continue;
        }
        let v;
        if (ch.isFloat && i0 + 1 < ch.count) {
          const frac = s - i0;
          v = ch.vals[i0] * (1 - frac) + ch.vals[i0 + 1] * frac;
        } else v = ch.vals[i0];
        cells[c + 1] = ch.isFloat ? fmt2(v) : String(Math.round(v));
      }
      out.push(cells.join(","));
    }
    return out.join("\n") + "\n";
  }

  // ../../../../websites/Alldatalogs/packages/datalog-core/src/holley/holley-channels.ts
  var HOLLEY_DICTS = [
    {
      product: "holley-v6-516",
      channelCount: 516,
      names: ["Point Number", "RTC", "RPM", "Inj PW", "Duty Cycle", "CL Comp", "Target AFR", "AFR Left", "AFR Right", "AFR Average", "Air Temp Enr", "Coolant Enr", "Coolant AFR Offset", "Afterstart Enr", "Current Learn", "CL Status", "Learn Status", "Fuel Economy", "Fuel Flow", "MAP RoC", "TPS RoC", "Tuning Change", "Estimated VE", "Fuel Table 1 %", "Fuel Table 2 %", "Fuel Table 3 %", "Ignition Timing", "Knock Retard", "Knock Level", "Spark Pad2", "IAC Position", "Target Idle Speed", "MAP", "TPS", "MAT", "CTS", "Baro", "Battery", "Oil Pressure", "Fuel Pressure", "Pedal Position", "Main Rev Limit", "Rev Limit #1", "Rev Limit #2", "AC Kick", "Timing Retard #1", "Timing Retard #2", "Timing Retard #3", "Fan #1", "Fan #2", "#2 Fuel Pump", "AC Shutdown", "TCC Lockup", "Sensor Warning", "Sensor Caution", "Base Fuel lb/hr", "Base Fuel VE", "Base Timing", "Base Target AFR", "Base Ign Dwell", "Vol Comp Ign Dwell", "Inj End Angle", "ECU Log Trigger", "Timing vs Air", "Timing vs Cool", "Status 1", "Status 2", "Status 3", "Status 4", "Status 5", "Status 6", "Status 7", "Status 8", "Inj Driver #1 PPH", "Inj Driver #2 PPH", "Inj Driver #3 PPH", "Inj Driver #4 PPH", "Inj Driver #5 PPH", "Inj Driver #6 PPH", "Inj Driver #7 PPH", "Inj Driver #8 PPH", "Inj Driver #9 PPH", "Inj Driver #10 PPH", "Inj Driver #11 PPH", "Inj Driver #12 PPH", "Inj Driver #13 PPH", "Inj Driver #14 PPH", "Inj Driver #15 PPH", "Inj Driver #16 PPH", "Inj Driver #17 PPH", "Inj Driver #18 PPH", "Inj Driver #19 PPH", "Inj Driver #20 PPH", "Inj Driver #21 PPH", "Inj Driver #22 PPH", "Inj Driver #23 PPH", "Inj Driver #24 PPH", "Inj Driver #25 PPH", "Inj Driver #26 PPH", "Inj Driver #27 PPH", "Inj Driver #28 PPH", "Inj Driver #1 PW", "Inj Driver #2 PW", "Inj Driver #3 PW", "Inj Driver #4 PW", "Inj Driver #5 PW", "Inj Driver #6 PW", "Inj Driver #7 PW", "Inj Driver #8 PW", "Inj Driver #9 PW", "Inj Driver #10 PW", "Inj Driver #11 PW", "Inj Driver #12 PW", "Inj Driver #13 PW", "Inj Driver #14 PW", "Inj Driver #15 PW", "Inj Driver #16 PW", "Inj Driver #17 PW", "Inj Driver #18 PW", "Inj Driver #19 PW", "Inj Driver #20 PW", "Inj Driver #21 PW", "Inj Driver #22 PW", "Inj Driver #23 PW", "Inj Driver #24 PW", "Inj Driver #25 PW", "Inj Driver #26 PW", "Inj Driver #27 PW", "Inj Driver #28 PW", "Cyl #1 Fuel Cor", "Cyl #2 Fuel Cor", "Cyl #3 Fuel Cor", "Cyl #4 Fuel Cor", "Cyl #5 Fuel Cor", "Cyl #6 Fuel Cor", "Cyl #7 Fuel Cor", "Cyl #8 Fuel Cor", "Cyl #9 Fuel Cor", "Cyl #10 Fuel Cor", "Cyl #11 Fuel Cor", "Cyl #12 Fuel Cor", "Cyl #13 Fuel Cor", "Cyl #14 Fuel Cor", "Cyl #15 Fuel Cor", "Cyl #16 Fuel Cor", "Cyl #1 Timing Cor", "Cyl #2 Timing Cor", "Cyl #3 Timing Cor", "Cyl #4 Timing Cor", "Cyl #5 Timing Cor", "Cyl #6 Timing Cor", "Cyl #7 Timing Cor", "Cyl #8 Timing Cor", "Cyl #9 Timing Cor", "Cyl #10 Timing Cor", "Cyl #11 Timing Cor", "Cyl #12 Timing Cor", "Cyl #13 Timing Cor", "Cyl #14 Timing Cor", "Cyl #15 Timing Cor", "Cyl #16 Timing Cor", "DI Target FP", "Boost PSIG", "Staging Input #1", "Staging Input #2", "Staging Output", "System Pad2", "System Pad3", "System Pad4", "Boost Gear", "Boost Stage", "Boost", "Boost Speed", "Boost Time", "Target Dome", "Trans Brake", "Boost Scramble +", "Boost Scramble -", "Manual Boost Build", "Manual Boost Reset", "Boost Build", "Boost Solenoid Duty", "Boost Safety", "Boost Master Enbl", "Boost Man Shift Inp", "Boost Man Stage Inp", "Boost Fill Sol DC", "Boost Vent Sol DC", "W/M Injection", "W/M Manual Enable", "W/M Low Fluid", "W/M Pump", "W/M Sol 1 Flow", "W/M Sol 2 Flow", "W/M Flow Total", "W/M Sol 1 DC", "W/M Sol 2 DC", "W/M Pad1", "W/M Pad2", "N2O Stage 1", "N2O Stage 2", "N2O Stage 3", "N2O Stage 4", "N2O Stage 5", "N2O Stage 6", "N2O Stage 7", "N2O Stage 8", "GPO 1", "GPO 2", "GPO 3", "GPO 4", "GPO 5", "GPO 6", "GPO 7", "GPO 8", "N2O Enabled", "N2O Input #1", "N2O Input #2", "N2O Input #3", "N2O Input #4", "N2O Input #5", "N2O Input #6", "N2O Input #7", "N2O Input #8", "N2O Purge", "N2O Lean Cutoff", "N2O Rich Cutoff", "N2O RPM Cutoff", "N2O MAP Cutoff", "N2O Purge Output", "N2O Dry Fuel #1", "N2O Dry Fuel #2", "N2O Dry Fuel #3", "N2O Dry Fuel #4", "N2O Dry Fuel #5", "N2O Dry Fuel #6", "N2O Dry Fuel #7", "N2O Dry Fuel #8", "N2O Tmg Mod #1", "N2O Tmg Mod #2", "N2O Tmg Mod #3", "N2O Tmg Mod #4", "N2O Tmg Mod #5", "N2O Tmg Mod #6", "N2O Tmg Mod #7", "N2O Tmg Mod #8", "N2O Timer #1", "N2O Timer #2", "N2O Timer #3", "N2O Timer #4", "N2O Timer #5", "N2O Timer #6", "N2O Timer #7", "N2O Timer #8", "N20 Pad1", "N20 Pad2", "N20 Pad3", "N20 Pad4", "Gear", "Speed", "Line Pressure", "Input Shaft Speed", "Accum Pressure", "TCC Duty Cycle", "Line Temp", "Torque Time", "Trans Man US Input", "Trans Man DS Input", "Trans Auto/Man In", "Trans Range Pos", "Race Trans Launch", "Shift Single Out", "Shift Output 1-2", "Shift Output 2-3", "Shift Output 3-4", "Shift Output 4-5", "Shift Output 5-6", "Shift Output 6-7", "Shift Output 7-8", "Shift Over-Ride", "Shift Mster Enable", "Shift Ignition Cut", "Shift Timing Mod", "Shift Timer", "Conv Lockup #1", "Conv Lockup #2", "Conv Lockup #3", "Conv Lockup #4", "Conv Lock Disable", "Spool Assist Out 1", "Spool Assist Out 2", "External Dump", "Internal Dump", "Dump #3", "Dump #4", "Trans Dump Disable", "Trans Pad 2", "TB TPS #1", "TB TPS #2", "Pedal TPS #1", "Pedal TPS #2", "TB2 TPS #1", "TB2 TPS #2", "TB Position", "TB2 Position", "Brake Pedal", "DBW Pad2", "TC Smartdrop", "TC Timing Retard", "TC N2O Decrease", "TC Boost Decrease", "TC DBW Decrease", "DS Timing Offset", "CS Timing Offset", "DS Rev Limit", "CS Rev Limit", "TC Time", "TC Launch Input", "Diag #1", "Diag #2", "Diag #3", "Diag #4", "Diag #5", "Diag #6", "Diag #7", "Diag #8", "Diag #9", "Diag #10", "Diag #11", "Diag #12", "Diag #13", "Diag #14", "Diag #15", "Diag #16", "Diag #17", "Diag #18", "Diag #19", "Diag #20", "AT Launch Input", "AT Shift Input", "AT Manual Reset", "AT Gear", "Launch Knob", "AT 1D #2", "AT 1D #3", "AT 1D #4", "AT 1D #5", "AT 1D #6", "AT 1D #7", "AT 1D #8", "Oil PSI Safety", "3 step", "wheelie2d", "Spool timing", "spool fuel", "Timing Retard", "Launch Offset Kn", "AT 2D #8", "AT 1DGear #1", "AT 1DGear #2", "AT 1DGear #3", "AT 1DGear #4", "AT 1DGear #5", "AT 1DGear #6", "AT 1DGear #7", "AT 1DGear #8", "AT 2DGear #1", "AT 2DGear #2", "AT 2DGear #3", "AT 2DGear #4", "AT 2DGear #5", "AT 2DGear #6", "AT 2DGear #7", "AT 2DGear #8", "DRIVESHAFT RPM", "IAT PRE COOLER", "CC PRESSURE", "BRAKE INPUT", "LOGGING", "Dome Pressure", "KeyOn", "Convert Pressure", "Shock Travel (RR", "Shock Travel (LR", "Shock Travel (RF", "Shock Travel (LF", "RADIATOR TEMP", "TRANS TEMP", "Coolant Pressure", "EGT#1", "EGT#2", "EGT#3", "EGT#4", "EGT#5", "EGT#6", "EGT#7", "EGT#8", "Chassis Angle", "Pitch Velocity", "X Accel Raw", "X Accel Correcte", "ACASX Temp", "12 Pos AEM(L)", "12 Pos AEM(R)", "Turbo Shaft Spee", "OIL TEMP", "Backpressure", "Brake Pressure", "Input #35", "Input #36", "Input #37", "Input #38", "Input #39", "Input #40", "Input #41", "Input #42", "Input #43", "Input #44", "Input #45", "Input #46", "Input #47", "Input #48", "Input #49", "Input #50", "Input #51", "Input #52", "Input #53", "Input #54", "Input #55", "Input #56", "Input #57", "Input #58", "Input #59", "Input #60", "Input #61", "Input #62", "Input #63", "Input #64", "Input #65", "Input #66", "Input #67", "Input #68", "Input #69", "Input #70", "Input #71", "Input #72", "Input #73", "Input #74", "DiffFuelPressure", "Converter Slip", "Dome Error", "EBP", "Lambda", "IC Boost Drop", "SHIFT LIGHT", "Oil Pump Power", "Shifter", "Safety Out", "Bst Cntrl Pwr", "Egate PWM-", "Egate Shutdown", "ExternalDump", "Internal Dump", "Rear Linelock", "Output #11", "Output #12", "Output #13", "Output #14", "Output #15", "Output #16", "Output #17", "Output #18", "Output #19", "ACAS Launch Zero", "Output #21", "Output #22", "Output #23", "Output #24", "Output #25", "Output #26", "Output #27", "Output #28", "Output #29", "Output #30", "Output #31", "Output #32", "Output #33", "Output #34", "Output #35", "Output #36", "Output #37", "Output #38", "Output #39", "Output #40", "Output #41", "Output #42", "Output #43", "Output #44", "Output #45", "Output #46", "Output #47", "Output #48", "Output #49", "Output #50", "Output #51", "Output #52", "Output #53", "Output #54", "Output #55", "Output #56", "Output #57", "Output #58", "Output #59", "Output #60", "Output #61", "Output #62"],
      units: ["", "sec", "RPM", "msec", "%", "%", "A/F", "A/F", "A/F", "A/F", "%", "%", "A/F", "%", "%", "", "", "mpg", "lb/hr", "kpa/sec x10", "%/sec", "", "%", "%", "%", "%", "\uFFFD", "\uFFFD", "%", "", "%", "RPM", "kPa", "%", "\uFFFDF", "\uFFFDF", "kPa", "Volts", "psi", "psi", "%", "", "", "", "", "\uFFFD", "\uFFFD", "\uFFFD", "", "", "", "", "", "", "", "lb/hr", "%", "\uFFFD", "A/F", "msec", "msec", "\uFFFD", "sec", "%\uFFFD", "%\uFFFD", "", "", "", "", "", "", "", "", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "%", "%", "%", "%", "%", "%", "%", "%", "%", "%", "%", "%", "%", "%", "%", "%", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "bar", "psig", "", "", "%", "", "", "", "", "", "psig", "MPH", "sec", "psig", "", "", "", "", "", "", "%", "", "", "", "", "%", "%", "%", "", "", "", "lb/hr", "lb/hr", "lb/hr", "%", "%", "", "", "%", "%", "%", "%", "%", "%", "%", "%", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "%", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "sec", "sec", "sec", "sec", "sec", "sec", "sec", "sec", "", "", "", "", "", "MPH", "%", "RPM", "%", "%", "\uFFFDF", "sec", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "\uFFFD", "sec", "%", "%", "%", "%", "", "", "", "%", "%", "%", "%", "", "", "Volts", "Volts", "Volts", "Volts", "Volts", "Volts", "%", "%", "", "", "", "\uFFFD", "%", "PSI", "%", "\uFFFD", "\uFFFD", "", "", "sec", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "RPM", "%", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "RPM", "\uFFFD", "\uFFFD", "A/F", "\uFFFD", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "rpm", "\uFFFDF", "kPa", "", "", "psi", "\uFFFDF", "psi", "in", "in", "in", "in", "\uFFFDF", "\uFFFDF", "psi", "\uFFFDF", "\uFFFDF", "\uFFFDF", "\uFFFDF", "\uFFFDF", "\uFFFDF", "\uFFFDF", "\uFFFDF", "\uFFFD", "d/s", "G", "G", "\uFFFD", "#", "#", "RPM", "\uFFFDF", "psi", "psi", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "%", "", "", "", "", "%", "", "%", "%", "", "", "", "", "", "", "", "", "", "", "%", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]
    }
  ];
  function holleyDictForChannels(nCh) {
    return HOLLEY_DICTS.find((d) => d.channelCount === nCh + 2);
  }

  // ../../../../websites/Alldatalogs/packages/datalog-core/src/holley/dl-to-csv.ts
  var CLOCK_LO = 1e8;
  var CLOCK_HI = 4293e6;
  var GAP_MAX = 1e5;
  function isHolleyDl(buf) {
    return buf.length > 16 && buf[0] === 31 && buf[1] === 244 && buf[2] === 133 && buf[3] === 0;
  }
  function detectHolleyLayout(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const L = buf.length;
    const u32 = (o) => dv.getUint32(o, true);
    const clock = (v) => v >= CLOCK_LO && v <= CLOCK_HI;
    const sustains = (A2, rB2, need) => {
      let prev = u32(A2);
      for (let k = 1; k <= need; k++) {
        const o = A2 + k * rB2;
        if (o + 4 > L) return false;
        const v = u32(o);
        const d = v - prev;
        if (!(d >= 1 && d <= GAP_MAX)) return false;
        prev = v;
      }
      return true;
    };
    let A = -1;
    let rB = 0;
    outer: for (let a = 8; a + 4e4 < L; a += 4) {
      if (!clock(u32(a))) continue;
      for (let cand = 16; cand <= 4e4; cand += 8) {
        if (clock(u32(a + cand)) && sustains(a, cand, 40)) {
          A = a;
          rB = cand;
          break outer;
        }
      }
    }
    if (A < 0) throw new Error("Not a recognizable Holley .dl data log (no sample-clock data section found).");
    let ds = A;
    while (ds - rB >= 0) {
      const d = u32(ds) - u32(ds - rB);
      if (!(d >= 1 && d <= GAP_MAX) || !clock(u32(ds - rB))) break;
      ds -= rB;
    }
    return { rowBytes: rB, nCh: (rB - 8) / 8, dataStart: ds, nRows: Math.floor((L - ds) / rB) };
  }
  function fmt(v) {
    if (!isFinite(v)) return "";
    if (v === 0) return "0";
    const a = Math.abs(v);
    if (a >= 1e-4 && a < 1e7) {
      let s = v.toFixed(6);
      if (s.indexOf(".") >= 0) s = s.replace(/\.?0+$/, "");
      return s;
    }
    return v.toPrecision(7);
  }
  function readCStr(buf, o, max = 30) {
    let s = "";
    for (let i = o; i < o + max && i < buf.length; i++) {
      const b = buf[i];
      if (b === void 0 || b === 0 || b < 32 || b > 126) break;
      s += String.fromCharCode(b);
    }
    return s;
  }
  function readHolleyAnalogLabels(buf, headerEnd) {
    const REC = 56;
    const limit = Math.min(headerEnd, buf.length);
    const isRec = (rs) => rs + REC <= limit && readCStr(buf, rs + 16).length >= 2 && /^%.*f/.test(readCStr(buf, rs + 62));
    let best = { start: -1, len: 0 };
    for (let s = 8e3; s < limit - REC; s++) {
      if (!isRec(s)) continue;
      let n = 0;
      let o = s;
      while (isRec(o)) {
        n++;
        o += REC;
      }
      if (n > best.len) best = { start: s, len: n };
      s = o - 1;
    }
    const out = [];
    for (let k = 0; k < best.len; k++) {
      const o = best.start + k * REC;
      out.push({ name: readCStr(buf, o + 16), unit: readCStr(buf, o + 56) });
    }
    return out;
  }
  function convertHolleyDlToCsv(input) {
    const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (!isHolleyDl(buf)) throw new Error("Not a Holley .dl file (missing 1F F4 85 00 signature).");
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const { rowBytes, nCh, dataStart, nRows } = detectHolleyLayout(buf);
    const dict = holleyDictForChannels(nCh);
    const names = dict ? dict.names.slice(2) : Array.from({ length: nCh }, (_, i) => `Channel ${i + 1}`);
    const units = dict ? dict.units.slice(2) : names.map(() => "");
    const chNames = names.length === nCh ? names : Array.from({ length: nCh }, (_, i) => `Channel ${i + 1}`);
    const chUnits = units.length === nCh ? units : chNames.map(() => "");
    if (nCh === 514) {
      const labels = readHolleyAnalogLabels(buf, dataStart);
      const INPUT_START = 372;
      const INPUT_COUNT = 74;
      for (let k = 0; k < INPUT_COUNT && INPUT_START + k < nCh; k++) {
        const idx = INPUT_START + k;
        const lbl = labels[k];
        if (lbl && lbl.name) {
          chNames[idx] = lbl.name;
          chUnits[idx] = lbl.unit;
        } else {
          chNames[idx] = `Input #${k + 1}`;
          chUnits[idx] = "";
        }
      }
    }
    const t0 = dv.getUint32(dataStart, true);
    const parts = [];
    parts.push("Offset," + chNames.join(","));
    parts.push("sec," + chUnits.join(","));
    for (let r = 0; r < nRows; r++) {
      const base = dataStart + r * rowBytes;
      const time = (dv.getUint32(base, true) - t0) / 1e3;
      const cells = new Array(nCh + 1);
      cells[0] = fmt(time);
      for (let k = 0; k < nCh; k++) cells[k + 1] = fmt(dv.getFloat32(base + 8 + k * 8, true));
      parts.push(cells.join(","));
    }
    return parts.join("\n");
  }

  // ../../../../websites/Alldatalogs/apps/web/public/parse-worker.js
  self.pako = import_pako_min.default;
  self.DVCore = entry_exports;
  self.onmessage = async (e) => {
    const data = e.data || {};
    const jobId = data.jobId;
    try {
      const ab = data.buffer || (data.file ? await data.file.arrayBuffer() : null);
      if (!ab) throw new Error("No file data received.");
      const bytes = new Uint8Array(ab);
      let csvText;
      if (data.fmt === "HPL") {
        csvText = convertHplToCsv(bytes, (d) => import_pako_min.default.inflateRaw(d), { interpolate: true, usUnits: true });
      } else if (data.fmt === "MoTeC") {
        csvText = convertLdToCsv(bytes);
      } else if (data.fmt === "Holley") {
        csvText = convertHolleyDlToCsv(bytes);
      } else {
        csvText = new TextDecoder().decode(bytes);
      }
      const parsed = parseDatalogCsv(csvText);
      self.postMessage({ jobId, ok: true, parsed });
    } catch (err) {
      self.postMessage({ jobId, ok: false, error: err && err.message ? err.message : String(err) });
    }
  };
})();
/*! pako 2.1.0 https://github.com/nodeca/pako @license (MIT AND Zlib) */
