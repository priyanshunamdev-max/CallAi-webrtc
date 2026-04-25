function createInterruptionController() {
  let isInterrupted = false;

  return {
    interrupt() {
      isInterrupted = true;
    },
    reset() {
      isInterrupted = false;
    },
    getState() {
      return { isInterrupted };
    }
  };
}

module.exports = { createInterruptionController };
