import { createBackendRuntime, type BackendRuntime } from './runtime'

export async function runWorker(runtime: BackendRuntime) {
  void runtime
  console.log('Backend worker entrypoint initialized; no background handlers are registered yet.')
}

export async function main() {
  const runtime = createBackendRuntime()

  try {
    await runWorker(runtime)
  } finally {
    await runtime.close()
  }
}

if (import.meta.main) {
  await main()
}
