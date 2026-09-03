import type { ZapretListId } from '@shared/ipc-contract'

export const LIST_TITLES: Record<ZapretListId, string> = {
  general: 'Обходить',
  google: 'YouTube / Google',
  exclude: 'Не трогать',
  'ipset-exclude': 'Исключённые подсети',
  'ipset-all': 'Подсети (IP)'
}

export const LIST_HINTS: Record<ZapretListId, string> = {
  general: 'Обход применяется только к этим сайтам.',
  google: 'Отдельный список — YouTube и Google обрабатываются иначе, чем остальные сайты.',
  exclude: 'Эти сайты обход не трогает никогда — банки и похожие сервисы стоит оставить здесь.',
  'ipset-exclude': 'Подсети, которые обход тоже не трогает (локальная сеть и т. п.).',
  'ipset-all':
    'Windows: адреса, к которым обход применяется по IP, а не по имени сайта — на случай, ' +
    'если один хост прячет за собой сразу несколько доменов.'
}
