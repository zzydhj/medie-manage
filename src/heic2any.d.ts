// heic2any 无自带类型声明:仅用于客户端动态 import 做 HEIC→JPEG 转码
declare module 'heic2any' {
  const heic2any: (options: {
    blob: Blob;
    toType?: string;
    quality?: number;
    gifInterval?: number;
  }) => Promise<Blob | Blob[]>;
  export default heic2any;
}
