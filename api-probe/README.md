# Telegram Business API Probe (Phase 1)

Исследовательский инструмент. **Не продукт.** Задача — получить **реальные payload'ы**
Telegram Business API и экспериментально подтвердить/опровергнуть ограничения, описанные
в `../docs/01-research-telegram-api.md`.

Поток данных предельно простой:

```
incoming webhook  →  проверка секрета  →  raw JSON в logs/  →  красивый вывод в консоль
```

Никакой базы данных, Mini App, UI, подписок, авторизации. Только логгер.

---

## 0. Что понадобится

- **Node.js ≥ 20** (проверено на 22).
- **Тестовый бот** (через @BotFather) с включённым **Business Mode**.
- **Аккаунт с Telegram Premium** — обязательное условие: без Premium раздел
  «Telegram Business» недоступен и бота подключить нельзя.
- Желательно **второй аккаунт** (собеседник) для сценариев удаления E-3…E-9.
- **Туннель** для HTTPS-webhook: `ngrok` **или** `cloudflared`.

> ⚠️ Логи в `logs/` содержат реальные личные сообщения. Папка в `.gitignore`.
> Используйте тестовые аккаунты и не коммитьте содержимое `logs/`.

---

## 1. Создать тестового бота

1. Откройте **@BotFather** → `/newbot` → задайте имя и username.
2. Скопируйте **токен** (`123456:ABC...`).

## 2. Включить Business Mode

1. @BotFather → `/mybots` → выберите бота → **Bot Settings** → **Business Mode** → **Turn on**.
2. Проверка: после шага 4 выполните `npm run get-me` — в ответе должно быть
   `"can_connect_to_business": true`.

## 3. Настроить проект

```bash
cd api-probe
npm install
cp .env.example .env      # Windows PowerShell: copy .env.example .env
```

Заполните `.env`:

- `BOT_TOKEN` — токен из шага 1.
- `WEBHOOK_SECRET` — длинная случайная строка. Сгенерировать:
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `PORT` — например `3000`.
- `PUBLIC_URL` — заполним после шага 4 (публичный HTTPS-адрес туннеля, без слэша в конце).

## 4. Поднять сервер и туннель

Терминал A — сервер:
```bash
npm run dev
```

Терминал B — туннель на тот же порт:
```bash
# вариант ngrok
ngrok http 3000
# или cloudflared
cloudflared tunnel --url http://localhost:3000
```

Скопируйте выданный `https://...` адрес в `PUBLIC_URL` в `.env` и перезапустите `npm run dev`
(порт менять не нужно; меняется только публичный адрес туннеля).

## 5. Зарегистрировать webhook

```bash
npm run set-webhook       # ставит url + secret_token + business_* allowed_updates
npm run webhook-info      # проверить: url, pending_update_count, last_error, allowed_updates
```

`allowed_updates` обязательно включает `business_connection`, `business_message`,
`edited_business_message`, `deleted_business_messages` — **по умолчанию Telegram их не шлёт**.

## 6. Подключить бота через «Автоматизация чатов»

На **аккаунте-владельце** (с Premium), в **мобильном** приложении Telegram:

1. **Настройки → Telegram Бизнес → Чат-боты** (Settings → Telegram Business → Chatbots).
2. Введите **username** тестового бота.
3. Выберите набор чатов (**какие чаты** видит бот) и **права** (для E-тестов достаточно
   значений по умолчанию; для наблюдения удалений права на запись не требуются).
4. Сохраните. Telegram пришлёт на webhook `business_connection` — увидите его в консоли.

## 7. Проверить получение событий

- Напишите себе/собеседнику в разрешённом чате → должен прийти `business_message`.
- Если в консоли появляются цветные блоки и в `logs/` растут файлы — всё работает.
- Дальше идите по `TEST_PLAN.md` (E-1…E-10).

---

## Где смотреть результаты

- `logs/<время>__<тип>__u<update_id>.json` — по одному файлу на каждый update (удобно для анализа).
- `logs/all-updates.ndjson` — единый поток всех updates (удобно для diff/grep).
- Консоль — цветной разбор + для `deleted_business_messages` явная проверка
  «content / initiator / timestamp = ABSENT».

## Команды

| Команда | Действие |
|---|---|
| `npm run dev` | сервер с автоперезапуском |
| `npm start` | сервер без watch |
| `npm run set-webhook` | зарегистрировать webhook |
| `npm run webhook-info` | статус webhook |
| `npm run delete-webhook` | удалить webhook |
| `npm run get-me` | проверить токен и Business Mode |
| `npm run typecheck` | проверка типов |

## Сброс между экспериментами

`npm run set-webhook` вызывается с `drop_pending_updates: true`, поэтому очищает очередь.
Логи можно архивировать/чистить вручную: файлы в `logs/` независимы.
