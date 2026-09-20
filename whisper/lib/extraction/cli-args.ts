/**
 * Argument parsing for scripts/transcribe.ts, kept here so it can be unit-tested:
 * importing the script itself would run it.
 */
export type CliArgs = {
  target: string | undefined
  json: boolean
  out: string | null
}

export function parse_args(argv: string[]): CliArgs {
  const out_flag = argv.indexOf('--out')
  const out = out_flag === -1 ? null : (argv[out_flag + 1] ?? null)

  // The value after --out is not a positional. Only skip that slot when the flag
  // is actually present: with no flag, `-1 + 1` is index 0, which is the target.
  const out_value_index = out_flag === -1 ? -1 : out_flag + 1
  const positional = argv.filter((a, i) => !a.startsWith('--') && i !== out_value_index)

  return { target: positional[0], json: argv.includes('--json'), out }
}
