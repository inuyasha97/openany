// The backend owns PTYs and services. Give it a chance to release all of them
// before Electron exits; the default deadline includes the terminal runtime's
// 20-second grace plus the remaining backend cleanup. An external server
// remains externally owned.
export async function stopEmbeddedServer(handle, { warn, timeoutMs = 35_000 }) {
  if (!handle) return;
  let timer;
  try {
    await Promise.race([
      handle.stop({ exitProcess: false }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Embedded server shutdown timed out')), timeoutMs);
      }),
    ]);
  } catch (error) {
    warn(error);
  } finally {
    clearTimeout(timer);
  }
}
