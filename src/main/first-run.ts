import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, dialog, type BrowserWindow } from 'electron'
import { GITHUB_URL } from '../shared/links'
import { openExternal } from './window'

/**
 * Метка «приветствие уже показывали». Лежит в userData, поэтому переживает обновление
 * приложения — окно показывается один раз за всё время, а не после каждой установки.
 */
function markerPath(): string {
  return join(app.getPath('userData'), 'first-run.json')
}

async function alreadyShown(): Promise<boolean> {
  try {
    await access(markerPath())
    return true
  } catch {
    return false
  }
}

/**
 * Приветственное окно при первом запуске: просьба поддержать проект звёздочкой.
 *
 * Рисует его сама ОС (`dialog.showMessageBox`), а не HTML-страница: так окно получается
 * маленьким, модальным к главному и выглядит системным, а не как ещё один экран приложения.
 */
export async function showFirstRunSupportDialog(window: BrowserWindow): Promise<void> {
  if (await alreadyShown()) return

  // Метку ставим ДО показа, а не после ответа: если приложение закроют прямо на диалоге,
  // лучше не показать его больше никогда, чем спрашивать при каждом запуске.
  try {
    await writeFile(markerPath(), JSON.stringify({ shownAt: new Date().toISOString() }), 'utf8')
  } catch {
    // Не смогли записать метку — покажем окно ещё раз в следующий запуск. Не повод падать.
  }

  const { response } = await dialog.showMessageBox(window, {
    type: 'info',
    buttons: ['Перейти', 'Закрыть'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: 'Поддержите SenBoost',
    message: 'Поддержите проект',
    detail: 'Поддержите проект звездочкой на GitHub, и расскажите друзьям :З'
  })

  // openExternal (window.ts) проверяет протокол по белому списку — ссылка уходит
  // в системный браузер, а не открывается внутри приложения.
  if (response === 0) openExternal(GITHUB_URL)
}
