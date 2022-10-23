class CoreAdapter {
  getInput(key: string): string {
    if (process.env[key]?.valueOf() === "") {
      throw Error("No " + key + " in env.");
    }
    return process.env[key]?.valueOf() ?? "";
  }

  setFailed(value: string) {
    console.log(value);
    process.exit(1);
  }

  setOutput(key: string, value: string) {
    process.env[key] = value;
  }

  info(value: string) {
    console.log(value);
  }

  debug(value: string) {
    console.log(value);
  }
}

export default CoreAdapter;
