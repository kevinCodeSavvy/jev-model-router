/**
 * A one-time pointer to the command that saves a TypeSafe key.
 *
 * Shown at session start when no key is set, then never again: the flag lives
 * in the plugin's `$.store`, so it survives restarts. It only prints the
 * command, which asks for the key with hidden input; it never reads or logs one.
 */

export const KEY_HINT_KEY = 'key-hint-shown'

export function keyHintText(plugin: string): string {
  return (
    '[jev-model-router] No TypeSafe key is set, so routing uses the built-in classifier (no confidence score). ' +
    'To add your key, run this in your own terminal (the prompt hides what you paste), then restart Claude Code: ' +
    `printf 'TypeSafe API key (hidden): '; read -rs K; echo; ` +
    `printf '{"typesafeApiKey":"%s"}' "$K" | claude plugin configure ${plugin} --values-stdin; unset K`
  )
}

/** True once the hint has been shown; anything unreadable counts as not shown. */
export function hintShown(value: unknown): boolean {
  return value === true
}
