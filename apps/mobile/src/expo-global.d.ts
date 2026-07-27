declare global {
  namespace globalThis {
    namespace expo {
      function uuidv4(): string;
    }
  }
}

export {};
