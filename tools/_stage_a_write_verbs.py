# -*- coding: utf-8 -*-
"""写操作动词黑名单（Stage-A 探针静态只读核证用）。

本文件与探针本体分离，目的只有一个：让「探针本体对这些动词 0 命中」
成为一个可被机器独立复算的命题，而不是探针自己在 json 里写死的 hits: 0。

若黑名单与探针同处一个文件，则该文件必然因声明清单而自我命中，
静态扫描就退化为自证清白，无法满足 Tom 第十一轮的核证要求。
本模块本身不发起任何网络请求、不触碰任何 Google Sheets API。
"""
WRITE_VERBS = [
    'patchCellsCAS',
    'patchCells',
    'setValue',
    'setValues',
    'deleteRows',
    'insertRows',
    'tsAppendRows',
    'deleteTsRowByCRowAndUuid',
    'hydrateRowValues',
    'archiveVisibleRow',
    'writeDeliverables',
    'clearContent',
    'clear',
]
