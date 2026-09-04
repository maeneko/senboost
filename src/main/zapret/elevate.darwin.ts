import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Запускает привилегированный скрипт из `resources/darwin-helper/` через системный диалог
 * авторизации — единственное место в приложении, где macOS просит пароль администратора.
 * Логика перенесена из старого `proxy.darwin.ts` (`networksetup()`), где так же собиралась
 * команда `osascript -e 'do shell script "..." with administrator privileges'`: одинарные
 * кавычки вокруг каждого аргумента и `'` внутри значения экранируется как `'\''` — тот же
 * приём, что `quoteConfigArg()` в `strategies.ts` использует для strategy.cfg.
 */
export async function runPrivileged(scriptPath: string, args: string[]): Promise<void> {
  const command = [scriptPath, ...args]
    .map((part) => `'${part.replaceAll("'", `'\\''`)}'`)
    .join(' ')

  try {
    await run('/usr/bin/osascript', [
      '-e',
      `do shell script "${command.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}" with administrator privileges`
    ])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // -128 — «User canceled» из Authorization Services: пользователь закрыл диалог пароля
    // или нажал «Отмена», это не ошибка выполнения скрипта, а отказ от неё.
    if (message.includes('-128')) {
      throw new Error('Операция отменена — не введён пароль администратора.', { cause: error })
    }
    throw new Error(`Не удалось выполнить привилегированную операцию: ${message}`, {
      cause: error
    })
  }
}
