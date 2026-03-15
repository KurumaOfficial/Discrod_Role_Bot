# Discrod_Role_Bot

Kuruma сделал этот инструмент для одного сценария: ты сохраняешь роли участников с основного Discord-сервера, потом пересоздаёшь структуру сервера через сторонний инструмент, а затем локальная панель аккуратно возвращает роли пользователям без ручного перебора 500 человек.

## Что умеет

- Снимать snapshot ролей и участников с живого Discord-сервера.
- Импортировать и экспортировать snapshot в JSON.
- Автоматически сопоставлять старые и новые роли по имени.
- Показывать preview до записи в Discord.
- Восстанавливать роли через безопасную очередь с задержкой между write-операциями.
- Пропускать bot-managed роли и вести отчёт по каждому участнику.

## Что нужно перед запуском

1. Создай Discord application и bot.
2. Включи `SERVER MEMBERS INTENT` в Discord Developer Portal.
3. Выдай боту право `Manage Roles`.
4. Подними роль бота выше всех ролей, которые он должен восстанавливать.
5. Заполни `.env`.

## .env

```env
DISCORD_BOT_TOKEN=PASTE_YOUR_DISCORD_BOT_TOKEN_HERE
DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=3007
TARGET_GUILD_ID=
DEFAULT_RESTORE_DELAY_MS=250
DEFAULT_RESTORE_REASON=Kuruma role restore after server structure migration
SKIP_BOT_ACCOUNTS=true
```

Если `TARGET_GUILD_ID` оставить пустым, панель позволит выбрать сервер из тех, где есть бот.

## Установка

```bash
npm install
npm start
```

После старта открой:

```text
http://127.0.0.1:3007
```

## Правильный рабочий поток

1. До миграции структуры сервера нажми `Capture current roles`.
2. Убедись, что snapshot сохранился.
3. Перенеси роли и каналы на основной сервер своим сторонним ботом.
4. Вернись в панель Kuruma.
5. Нажми `Auto-match by name`.
6. Руками проверь роли с конфликтами или дублями.
7. Нажми `Build preview`.
8. Если preview чистый, запускай `Start restore`.
9. После завершения скачай JSON-отчёт.

## Важные ограничения

- Если роль выше роли бота, Discord не даст её выдать. Панель это покажет как `locked`.
- Bot-managed роли и Nitro/booster роли этот инструмент не восстанавливает вручную. Они игнорируются.
- Если ты не снял snapshot до пересоздания ролей, бот не сможет сам угадать исходные роли участников.
- Для максимальной безопасности сначала прогони `Dry-run`.

## Git

```bash
git init
git branch -M main
git remote add origin https://github.com/KurumaOfficial/Discrod_Role_Bot.git
git add .
git commit -m "feat: add Kuruma Discord role restore dashboard"
git push -u origin main
```

## Автор

Engineered by Kuruma.
