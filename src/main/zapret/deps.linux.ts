import { access, constants } from 'node:fs/promises'

/**
 * `pkexec` из состава polkit — им поднимаем root для nftables/nfqws. Проверяем по конкретным
 * путям, а не через `PATH`: тот же мотив, что у `find_nft()` в `senboost-helper.sh` — санитайз
 * окружения инструментами вроде pkexec/env-с-урезанным-PATH встречается достаточно часто,
 * чтобы не полагаться на переменную окружения при поиске самого пути к элевации.
 */
const PKEXEC_CANDIDATES = ['/usr/bin/pkexec', '/bin/pkexec']

/** `nft` — тот же список путей, что перебирает `find_nft()` в помощнике (держим в синхроне). */
const NFT_CANDIDATES = ['/usr/sbin/nft', '/sbin/nft', '/usr/local/sbin/nft', '/usr/bin/nft']

async function findExecutable(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // пробуем следующий путь
    }
  }
  return null
}

/**
 * Проверка окружения до первого запроса пароля — тот же мотив, что у `assertExecutable()`
 * в `paths.ts`: без неё пользователь увидел бы «spawn pkexec ENOENT» или пустой отказ nft
 * внутри чужого stderr и не понял бы, что установить.
 */
export async function assertLinuxDependencies(): Promise<void> {
  if (!(await findExecutable(PKEXEC_CANDIDATES))) {
    throw new Error(
      'Не найден pkexec — установите пакет polkit ' +
        '(Debian/Ubuntu: «sudo apt install policykit-1»).'
    )
  }
  if (!(await findExecutable(NFT_CANDIDATES))) {
    throw new Error(
      'Не найдена утилита nft — установите пакет nftables (Debian/Ubuntu: «sudo apt install nftables»).'
    )
  }
}
