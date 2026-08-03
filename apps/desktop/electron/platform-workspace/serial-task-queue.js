export class SerialTaskQueue {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(operation) {
    const current = this.tail.then(operation, operation);
    this.tail = current.catch(() => {});
    return current;
  }
}
