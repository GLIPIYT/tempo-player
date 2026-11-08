# Кэш CI и release-сборок

Проверено 8 ноября 2026 года по [логу релиза v1.4.2](https://github.com/GLIPIYT/tempo-player/actions/runs/42483298546) и GitHub Actions Cache API.

## Причина полных сборок

- В release restore был `No cache found`. Запрошенный ключ: `v0-rust-build-Windows_NT-x64-e70cdc14-09cadab6`.
- Кэш `main` имел другой ключ: `v0-rust-check-Windows_NT-x64-e70cdc14-09cadab6`. Различался идентификатор job, а не каталог `target` или набор зависимостей.
- Сохранённые release-кэши примерно по 631 МБ находились в областях отдельных тегов. Новый тег не мог восстановить кэш предыдущего тега.
- CI компилировал test/debug-профиль, release — optimized. Одного совпадения ключей недостаточно: на `main` должны существовать и release-артефакты зависимостей.
- Rust release-сборка заняла 15 минут 17 секунд. На момент проверки 27 записей кэша занимали 10 103 293 217 байт; создавать ещё одну изолированную копию при каждом теге невыгодно.

`workspaces: src-tauri` уже указывал на правильный `src-tauri/target`: ошибку пути лог не подтверждает.

## Изменения

Оба workflow используют `shared-key: windows-msvc-deps-v1`. Сохраняет Rust-кэш только успешная сборка `main`; теги и PR его читают. После тестов на push в `main` выполняется `npm run tauri -- build --no-bundle --ci -- --locked`: первая новая запись содержит зависимости обоих профилей. Tauri сам собирает frontend и включает production-features, в том числе `tauri/custom-protocol`; один обычный `cargo build --release` не гарантирует тот же набор зависимостей. На PR дополнительная release-сборка не запускается, установщик на `main` не публикуется.

Для npm используется общий кэш скачанных пакетов с fallback по ОС и архитектуре. Изменение номера приложения в lockfile больше не требует заново скачивать все уже имеющиеся tarball-пакеты. `npm ci --prefer-offline` продолжает устанавливать по настоящему lockfile и проверять integrity. `node_modules` не кэшируется. Сохранение npm-кэша ограничено `main`; автоматическое второе кэширование setup-node отключено.

## Практические ограничения

Первая сборка нового ключа всё равно холодная. Перед следующим тегом желательно дождаться её успешного завершения: одновременный push первого `main` и тега не заставляет тег ждать прогрева.

На push в `main` теперь есть дополнительная полноценная release-проверка. Это переносит прогрев на CI и увеличивает его работу; сборка самого Tempo, линковка и упаковка при релизе остаются. Workspace-крейт не включён в dependency cache. Изменение rustc или зависимостей закономерно создаёт новый ключ. Точный выигрыш следующих релизов пока не измерен.

Workflow проверены actionlint 1.7.12. Для подтверждения первого удалённого прогрева нужно увидеть успешное сохранение нового shared-key в области `main`; одна локальная проверка YAML этого не доказывает.

## Документация

- [Swatinem/rust-cache: shared-key, save-if, состав кэша](https://github.com/Swatinem/rust-cache).
- [GitHub: области доступности и неизменяемые записи кэша](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).
- [actions/cache: restore/save и fallback-ключи](https://github.com/actions/cache).
- [Tauri CLI: production build без упаковки](https://v2.tauri.app/reference/cli/#build).
