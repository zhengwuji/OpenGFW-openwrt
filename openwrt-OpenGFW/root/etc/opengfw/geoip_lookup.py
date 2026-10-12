#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v2fly geoip.dat 的 IP→国家代码 查询模块 (纯标准库, 带磁盘缓存)

用法:
    python3 geoip_lookup.py '["192.0.2.1", "198.51.100.1"]'   →  {"192.0.2.1": "US", "198.51.100.1": "US"}
    (参数也可从 stdin 传入同样的 JSON 数组)

被 opengfw-custom-helper 的 geoip-lookup 命令与 recent-blocks 聚合调用,
用于 LuCI 白名单/黑名单条目旁显示国家旗帜。
首次运行解析 geoip.dat 并生成 geoip_cache.bin 索引; 之后 geoip.dat 未变化时直接加载缓存。
"""
import io
import json
import os
import pickle
import sys
from array import array
from bisect import bisect_right

DAT = '/etc/opengfw/geoip.dat'
CACHE = '/etc/opengfw/geoip_cache.bin'


def _rd_varint(buf, i):
    shift = 0
    val = 0
    while True:
        b = buf[i]
        i += 1
        val |= (b & 0x7F) << shift
        if not (b & 0x80):
            return val, i
        shift += 7


def _iter_fields(buf, start, end):
    """迭代 protobuf 字段: 产出 (field_no, wire_type, value)
    wire 2 → value=(内容起,内容止); wire 0 → value=整数"""
    i = start
    while i < end:
        tag, i = _rd_varint(buf, i)
        f, wt = tag >> 3, tag & 7
        if wt == 2:
            ln, i = _rd_varint(buf, i)
            yield f, wt, (i, i + ln)
            i += ln
        elif wt == 0:
            v, i = _rd_varint(buf, i)
            yield f, wt, v
        elif wt == 5:
            i += 4
        elif wt == 1:
            i += 8
        else:
            raise ValueError('bad wire type %d' % wt)


def _parse_cidr(buf, s, e):
    ipb = None
    prefix = None
    for f, wt, v in _iter_fields(buf, s, e):
        if wt == 2 and f == 1:
            ipb = buf[v[0]:v[1]]
        elif wt == 0 and f == 2:
            prefix = v
    if not ipb or prefix is None:
        return None
    bits = len(ipb) * 8
    if prefix > bits:
        return None
    base = int.from_bytes(ipb, 'big')
    return (base, base + (1 << (bits - prefix)) - 1, prefix, bits)


def build_index():
    with open(DAT, 'rb') as f:
        data = f.read()
    countries = []
    cc_idx = {}
    v4 = []
    v6 = []
    for f, wt, v in _iter_fields(data, 0, len(data)):
        if f != 1 or wt != 2:
            continue
        s, e = v
        cc = ''
        nets = []
        for cf, cwt, cv in _iter_fields(data, s, e):
            if cwt == 2 and cf == 1:
                cc = data[cv[0]:cv[1]].decode('ascii', 'replace')
            elif cwt == 2 and cf == 2:
                n = _parse_cidr(data, cv[0], cv[1])
                if n:
                    nets.append(n)
        if not cc:
            continue
        if cc not in cc_idx:
            cc_idx[cc] = len(countries)
            countries.append(cc)
        ci = cc_idx[cc]
        for base, end, prefix, bits in nets:
            (v4 if bits == 32 else v6).append((base, end, prefix, ci))
    v4.sort()
    v6.sort()

    def pack(lst, big=False):
        if not lst:
            return None
        if big:
            # IPv6 起点/终点是 128 位整数, 超出 array('Q') 上限, 用普通列表
            return {
                'st': [x[0] for x in lst],
                'en': [x[1] for x in lst],
                'pf': [x[2] for x in lst],
                'ci': [x[3] for x in lst],
            }
        return {
            'st': array('Q', [x[0] for x in lst]),
            'en': array('Q', [x[1] for x in lst]),
            'pf': array('H', [x[2] for x in lst]),
            'ci': array('H', [x[3] for x in lst]),
        }

    return {
        'v4': pack(v4),
        'v6': pack(v6, big=True),
        'countries': countries,
        'mtime_ns': os.stat(DAT).st_mtime_ns,
        'size': os.stat(DAT).st_size,
    }


def _maxend(idx):
    """前缀最大 end 数组, 用于回溯边界"""
    if not idx:
        return None
    me = []
    run = 0
    for v in idx['en']:
        if v > run:
            run = v
        me.append(run)
    return me


def _load():
    st = os.stat(DAT)
    if os.path.exists(CACHE):
        try:
            with open(CACHE, 'rb') as f:
                c = pickle.load(f)
            if c.get('mtime_ns') == st.st_mtime_ns and c.get('size') == st.st_size:
                return c
        except Exception:
            pass
    c = build_index()
    tmp = CACHE + '.tmp'
    with open(tmp, 'wb') as f:
        pickle.dump(c, f, protocol=2)
    os.replace(tmp, CACHE)
    return c


_IDX = None


def _get_idx():
    global _IDX
    if _IDX is None:
        _IDX = _load()
        _IDX['v4']['me'] = _maxend(_IDX['v4'])
        _IDX['v6']['me'] = _maxend(_IDX['v6'])
    return _IDX


def _find(idx, n):
    if not idx:
        return None
    st, en, pf, ci = idx['st'], idx['en'], idx['pf'], idx['ci']
    me = idx['me']
    i = bisect_right(st, n) - 1
    best = None
    while i >= 0 and me[i] >= n:
        if en[i] >= n and (best is None or pf[i] > pf[best]):
            best = i
        i -= 1
    return best


def lookup(ip):
    """IP 字符串 → 两位国家代码; 私网/保留/未知返回 ''"""
    import ipaddress
    try:
        a = ipaddress.ip_address(str(ip).strip())
    except ValueError:
        return ''
    if (a.is_private or a.is_loopback or a.is_multicast or a.is_reserved
            or a.is_link_local or a.is_unspecified):
        return ''
    n = int(a)
    idx = _get_idx()
    b = _find(idx['v4'], n) if a.version == 4 else _find(idx['v6'], n)
    if b is None:
        return ''
    return idx['countries'][idx['v6' if a.version == 6 else 'v4']['ci'][b]]


def main():
    raw = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()
    ips = json.loads(raw or '[]')
    out = {}
    for ip in ips[:400]:
        out[str(ip)] = lookup(ip)
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    main()
