import { PkmServiceBootOptions, startPkmService } from "./pkm-service";

// This entry is a detached Node process, not an extension-host worker. Never
// print request payloads, credentials, private content, or exception messages.
async function main(): Promise<void> {
  const options = JSON.parse(process.argv[2] || "") as PkmServiceBootOptions;
  const runtime = await startPkmService(options);
  console.log(`${new Date().toISOString()} PKM_SERVICE_STARTED pid=${process.pid} version=${options.extensionVersion}`);
  process.on("unhandledRejection", () => console.error(`${new Date().toISOString()} PKM_SERVICE_ASYNC_FAILURE`));
  await runtime.stopped;
  console.log(`${new Date().toISOString()} PKM_SERVICE_DRAINED pid=${process.pid}`);
}

if (require.main === module) {
  void main().then(() => process.exit(0), () => {
    console.error(`${new Date().toISOString()} PKM_SERVICE_START_FAILED pid=${process.pid}`);
    process.exit(1);
  });
}
