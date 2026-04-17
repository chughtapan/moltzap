/** Read an env var or exit with a clear error. */
export function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`missing env var: ${name}`);
    process.exit(1);
  }
  return value;
}
