const OUTPUT_BURST_SIZE = 128 * 1024;
const OUTPUT_BEGIN = "[moltzapd-output-begin]";
const OUTPUT_END = "[moltzapd-output-end]";

process.stderr.write(
  `${OUTPUT_BEGIN}${"x".repeat(OUTPUT_BURST_SIZE)}${OUTPUT_END}\n`,
);
