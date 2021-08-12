declare module 'stream-to-it' {
  import { Writable } from 'stream';

  export function sink(sink: Writable): () => void;
}
