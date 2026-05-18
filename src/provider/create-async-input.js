function createAsyncMessageInput() {
  const queue = [];
  const resolvers = [];
  let closed = false;

  return {
    push(item) {
      if (closed) return;
      const resolve = resolvers.shift();
      if (resolve) {
        resolve({ value: item, done: false });
        return;
      }
      queue.push(item);
    },
    end() {
      closed = true;
      while (resolvers.length > 0) {
        resolvers.shift()?.({ value: undefined, done: true });
      }
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (queue.length > 0) {
              const value = queue.shift();
              return Promise.resolve({ value, done: false });
            }
            if (closed) {
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise((resolve) => { resolvers.push(resolve); });
          },
        };
      },
    },
  };
}

module.exports = { createAsyncMessageInput };
