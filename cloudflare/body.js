// A request's body, read on the Durable Object for the request handler: up to `limit`
// bytes, and null past that, before the rest is read. The handler checks the size too, but
// only of a body that is already all in memory, and an upload can be far bigger than the
// Durable Object's memory. A Content-Length over the limit is refused unread; without one
// (a chunked upload), reading stops at the limit.
import { Buffer } from 'node:buffer';

export async function readBody(request, limit) {
  if (Number(request.headers.get('content-length')) > limit) return null;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value)); // a copy: a stream may reuse a chunk's memory
  }
}
