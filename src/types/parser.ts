/** 实现版本与标准协议版本独立；用于精确失效已生成的扫描缓存。 */
export interface ParserIdentity { id: string; version: string }
export interface ParserSnapshot { fingerprint: string; parsers: ParserIdentity[] }
