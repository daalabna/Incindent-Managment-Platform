# Sentinel

AI-помощник: сводка инцидента, гипотезы с источниками и скачиваемый черновик postmortem. Запуск вручную из карточки инцидента в PostgreSQL-режиме. [Настройка, ограничения и проверки](docs/ai-assistant.md).

Система управления техническими инцидентами: React + Fastify + PostgreSQL + Redis + RabbitMQ. Рабочий путь: приём события → transactional outbox → RabbitMQ → worker → правила и корреляция → PostgreSQL → Redis Pub/Sub → WebSocket → интерфейс.

## Быстрый запуск

Нужны Node.js 24+, npm и работающий Docker Desktop в режиме Linux containers.

```sh
npm install
npm run infra:up
npm run dev
```

Интерфейс: http://127.0.0.1:5173. API: http://127.0.0.1:4000. Режим по умолчанию — `distributed`: все три сервиса действительно используются. Без `infra:up` API падает на migrate (`ECONNREFUSED` к Postgres `:15432`), Vite тогда пишет `ECONNREFUSED :4000`. Автоматического перехода на SQLite нет.

Локальные значения уже заданы в коде; для настройки скопируйте `.env.example` в `.env`. Файл `.env` загружается автоматически. Переменные окружения процесса имеют приоритет. Внешние подключения — только на loopback. При `AUTH_REQUIRED=true` (PostgreSQL-режим) включаются sessions, CSRF, RBAC и rate limits; без флага `/api/auth/me` сразу отдаёт демо-админа (`Local operator`), форма входа не нужна. Локально с auth: `COOKIE_SECURE=false`, пользователь — `ADMIN_USERNAME` / `ADMIN_PASSWORD` и `npm run user:create`. Tenant задаётся schema/namespace (`INFRA_NAMESPACE`), полноценный multi-tenant SaaS — не цель текущего контура.

## Полностью в Docker

```sh
docker compose up --build -d --wait
```

Откройте http://127.0.0.1:4000. Compose запускает пять контейнеров: `sentinel` (API и собранный UI), отдельный `worker`, `postgres`, `redis`, `rabbitmq`. API ждёт health checks инфраструктуры. У worker и API общая PostgreSQL, а не отдельные SQLite-файлы.

Для остановки без удаления данных:

```sh
docker compose stop
```

Именованные volumes сохраняют PostgreSQL, Redis AOF и RabbitMQ. Не используйте `docker compose down -v`, если данные нужны.

## Подключения

| Компонент           | Адрес с компьютера               | Назначение                                            |
| ------------------- | -------------------------------- | ----------------------------------------------------- |
| PostgreSQL          | `127.0.0.1:15432`, БД `sentinel` | Инциденты, правила, сервисы, события, аудит, outbox   |
| Redis               | `127.0.0.1:6379`                 | Межпроцессные realtime-сигналы и блокировка симуляции |
| RabbitMQ AMQP       | `127.0.0.1:5672`                 | Доставка событий worker, retry, dead-letter queue     |
| RabbitMQ Management | http://127.0.0.1:15672           | Просмотр очередей и сообщений                         |

Учётные данные PostgreSQL и RabbitMQ для локального окружения: `sentinel` / `local-development-only`. Redis доступен только локально и не требует пароля. Внутри Compose используются имена сервисов и стандартный PostgreSQL-порт 5432. Снаружи выбран 15432, поскольку Windows на этом компьютере запрещает bind на 5432. Переопределение: `POSTGRES_PORT` в Compose и соответствующий `DATABASE_URL` для Node.js.

| Переменная           | По умолчанию                                                                       |
| -------------------- | ---------------------------------------------------------------------------------- |
| `SENTINEL_MODE`      | `distributed` (единственный prod-путь). `local` только с `ALLOW_SQLITE=true`       |
| `DATABASE_URL`       | `postgresql://sentinel:local-development-only@127.0.0.1:15432/sentinel`            |
| `REDIS_URL`          | `redis://127.0.0.1:6379`                                                           |
| `RABBITMQ_URL`       | `amqp://sentinel:local-development-only@127.0.0.1:5672`                            |
| `INFRA_NAMESPACE`    | `sentinel`; префикс очередей, exchanges и Redis-ключей                             |
| `EMBEDDED_WORKER`    | `true` в dev: consumer и фоновые циклы в API. `false`: только HTTP, циклы у worker |
| `HOST`, `PORT`       | `127.0.0.1`, `4000`                                                                |
| `WORKER_PORT`        | `4002`; health отдельного worker, только loopback                                  |
| `ALLOWED_HOSTS`      | пусто; дополнительные Host помимо localhost, 127.0.0.1 и ::1                       |
| `SIMULATION_TICK_MS` | `3000`; пауза между шагами демонстрации                                            |
| `ALLOW_SQLITE`       | не задан; `true` разрешает demo SQLite (`SENTINEL_MODE=local`)                     |
| `DATABASE_PATH`      | `data/sentinel.db`; только demo SQLite и `db:import-sqlite`                        |

Для отдельного worker вне Docker задайте API `EMBEDDED_WORKER=false`: этот процесс не потребляет очередь и не запускает dispatcher, operations и AI publisher. Затем выполните `npm run worker` во втором терминале. Все процессы одного workspace должны использовать одинаковые DATABASE_URL, Redis/RabbitMQ и INFRA_NAMESPACE. Другая БД требует отдельного namespace.

## Перенос существующей SQLite

Остановите старый API. Поднимите инфраструктуру и выполните:

```sh
npm run db:import-sqlite
```

Импортирует сервисы, правила, инциденты с таймлайном, аудит и все idempotency IDs в пустую PostgreSQL. Работает транзакционно; отказывается перезаписывать уже заполненную/импортированную БД. Исходный SQLite-файл не изменяется. Старые ID событий без payload импортируются как уже обработанные записи дедупликации. Новые номера инцидентов продолжают последовательность; пропуски номеров допустимы.

## Что проверить в UI

1. Нажмите **Simulate incident**. Генератор сохраняет Search latency/error events в PostgreSQL outbox.
2. Dispatcher отправляет сообщения в RabbitMQ, worker создаёт и объединяет алерты в P1-инцидент.
3. Откройте инцидент, назначьте себя, нажмите **Acknowledge**, затем **Investigate**.
4. Добавьте комментарий. Обновления приходят через Redis и WebSocket даже от отдельного worker.
5. Примерно через 12 секунд (`SIMULATION_TICK_MS`, по умолчанию 3000 мс × 4 шага) поступят события восстановления; после обработки метрик закройте инцидент.
6. Проверьте **Alert rules** и **Activity log**.

В RabbitMQ Management смотрите `sentinel.events.process`, `sentinel.events.retry`, `sentinel.events.dead`; быстро обработанная очередь обычно имеет нулевую глубину. Начальные графики сервисов — демонстрационный baseline, а не измерения внешнего production.

## Доставка и конкурентность

- Событие и outbox-запись фиксируются в одной PostgreSQL-транзакции. API отвечает `202` после commit, даже если RabbitMQ временно недоступен после запуска.
- Dispatcher отправляет persistent messages с `mandatory` и ждёт publisher confirm. `basic.return` для этой публикации считается ошибкой маршрутизации: outbox остаётся pending, topology заново объявляется, следующая попытка публикует сообщение ещё раз. Confirm без маршрута не считается доставкой.
- Worker делает manual ack после commit. Повторная доставка не создаёт повторные алерты: `processed_at` проверяется под блокировкой строки события. Для каждой пары сервис/метрика хранится sequence приёма PostgreSQL; более старое наблюдение не перезаписывает текущие latency, error rate или health check. Оно может добавить алерт только к ещё открытому инциденту и не создаёт новый после закрытия. Само событие остаётся в журнале.
- Корреляция сериализуется PostgreSQL-блокировкой строки сервиса и присоединяет алерт к ещё открытому инциденту этого сервиса. Новый инцидент создаётся, когда открытого нет. `incident_number` расходуется только в этом случае. Изменения инцидента дополнительно проверяют `version`; устаревшее изменение получает `409`.
- Здоровье сервиса собирается из независимых сигналов. Свежий health check со значением `1` даёт outage. Иначе свежие error rate > 5 или latency > 1200 ms дают degraded. Иначе любой свежий сигнал даёт healthy. Наблюдение старше 5 минут не участвует; если сигналы уже были и все устарели, здоровье становится `unknown`. Сервис без единого сигнала остаётся baseline healthy. Приоритет свежих сигналов: outage, затем degraded, затем healthy.
- Redis Pub/Sub передаёт `state.changed` с origin id между процессами. Отправитель не применяет собственное эхо, поэтому клиенты WebSocket получают один сигнал. Потеря realtime-сигнала компенсируется опросом сводки, списка инцидентов, журнала и открытой карточки раз в 15 секунд и полной загрузкой при reconnect. PostgreSQL остаётся источником истины.
- Redis lock симуляции использует уникальный token, TTL 60 секунд, продление перед каждым шагом и атомарное сравнение token при освобождении. При потере lease следующие шаги прекращаются. Это вспомогательная блокировка, не гарантия корректности данных; данные защищены транзакциями PostgreSQL.
- Временные ошибки обработки: три повтора через durable retry queue с TTL 1.5 секунды, затем DLQ. Неверные envelopes и невосстановимые доменные ошибки сразу отправляются в DLQ. Основной путь DLQ — публикация в `exchange.dead` с ключом `dead`. Если публикация в DLQ не подтвердилась, сообщение паркуется в retry queue с TTL 1.5 секунды, а исходное подтверждается. Статус `failed` пишется только после подтверждённой публикации в DLQ. Если не подтвердилась и эта парковка, сообщение возвращается в рабочую очередь через ту же паузу: брокер его не снимает, и consumer не читает его снова без ожидания. Обычная неудачная retry-публикация ждёт ту же паузу. `x-dead-letter-exchange` остаётся на очереди для отказа без requeue со стороны брокера. Повторный POST того же id возвращает `failed` и не обещает новую постановку в очередь; отдельной операции replay нет.
- RabbitMQ переподключается с номером поколения соединения: `close` отменяет уже начатый `connect` и закрывает позднее соединение. ioredis восстанавливает соединение и подписку. Readiness возвращает `503`, если PostgreSQL, Redis или RabbitMQ недоступны, consumer нет, или самый старый pending outbox старше 30 секунд. Ответ health содержит pending, retrying, failed, возраст старейшего pending, время последней обработки, глубину очереди и DLQ. Счётчики DLQ сами по себе процесс не перезапускают.
- Отдельный worker слушает `127.0.0.1:4002/health` (`WORKER_PORT`) и отдаёт тот же отчёт. Логи обработки содержат event id, номер попытки и текст ошибки; пароли из URL вырезаются.

Это at-least-once доставка с идемпотентной обработкой, а не exactly-once. Рабочие очереди называются с суффиксом `.v2` и объявляются как quorum. Сообщения из прежних classic-очередей переносятся при старте; сами очереди не удаляются. Один узел Compose не является HA-гарантией. В local-режиме более старый sequence не откатывает метрику. В event-time режиме актуален более поздний timestamp события. Дополнительные workers дают failover, а не параллельную обработку одной очереди. За nginx лимит логина считается по клиентскому адресу только от доверенного proxy (`TRUSTED_PROXIES`), а лимит API — по пользователю сессии.

## API

| Метод | Путь                 | Назначение                                                                           |
| ----- | -------------------- | ------------------------------------------------------------------------------------ |
| GET   | `/api/live`          | Liveness процесса                                                                    |
| GET   | `/api/health`        | Зависимости, consumer, возраст outbox, DLQ; 200/503                                  |
| GET   | `/api/summary`       | Сервисы, открытые инциденты, число закрытых, правила, последний аудит, число событий |
| GET   | `/api/state`         | Та же краткая сводка, что `/api/summary`: открытые инциденты без timeline            |
| GET   | `/api/incidents`     | Страница кратких инцидентов: `limit`, `cursor`, `status`, `q`                        |
| GET   | `/api/incidents/:id` | Инцидент с timeline                                                                  |
| GET   | `/api/activity`      | Страница аудита, `limit` и `offset`                                                  |
| POST  | `/api/events`        | Сохранить событие; distributed: 202, local: 200                                      |
| GET   | `/api/events/:id`    | `queued` / `processed` / `failed`; в local-режиме 404                                |
| PATCH | `/api/incidents/:id` | Изменить инцидент с version                                                          |
| POST  | `/api/rules`         | Создать правило                                                                      |
| PATCH | `/api/rules/:id`     | Включить/выключить правило                                                           |
| POST  | `/api/simulations`   | Запустить демонстрацию; 409, если уже выполняется                                    |
| WS    | `/ws`                | Одно уведомление `state.changed` на изменение                                        |

```json
{
  "id": "event-001",
  "source": "search-api",
  "type": "error_rate",
  "value": 12.8,
  "timestamp": "2026-10-07T12:00:00.000Z"
}
```

`id` и `timestamp` можно опустить. Числа должны быть конечными: `error_rate` от 0 до 100, `latency` от 0 до 120000 мс, `health` только 0 или 1. JSON `1e400` отклоняется с 400 и не записывается. Для идемпотентных повторов передавайте стабильный `id`. Повтор ID с другим source/type/value — 409. Повтор уже проваленного события возвращает `failed`. Неизвестный сервис — 404; неверный payload — 400. Ответ 202 не означает, что инцидент уже создан: проверьте GET статуса события или дождитесь realtime.

Запросы принимаются только с Host `localhost`, `127.0.0.1` или `::1`. Дополнительные имена задаются в `ALLOWED_HOSTS`. Origin, если он есть, проверяется по тому же списку, а не по присланному Host.

```json
{ "version": 1, "status": "acknowledged", "assignee": "Local operator" }
```

Изменение инцидента также принимает `severity` и `comment`. Lifecycle: `triggered → acknowledged → investigating → mitigated → resolved`, либо `investigating → resolved`.

## Проверки

```sh
npm run build
npm test
npm run infra:up
npm run test:integration
npx playwright install chromium
npm run test:e2e
npm run test:e2e:distributed
```

Интеграционные и distributed E2E-тесты создают отдельные случайно именованные PostgreSQL-БД и RabbitMQ-очереди, затем удаляют только их. Рабочая БД не очищается. Пользователь PostgreSQL для тестов должен иметь CREATEDB. Браузерные тесты используют отдельные порты 4001/5174, которые должны быть свободны. В CI запускаются все проверки.

## Структура и ограничения

- `shared/contracts.ts` — схемы входа и ответов API. `server/domain/apply.ts` — чистые операции над снимком; транзакции и dedup остаются в адаптерах.
- `server/domain/domain.ts` и `server/db/store.ts` — in-memory/SQLite только для unit-тестов и demo (`ALLOW_SQLITE=true`); prod — PostgreSQL.
- `server/db/postgres.ts`, `server/db/migrations/` — PostgreSQL, миграции и outbox.
- `server/broker/rabbit.ts` — topology, mandatory publisher, consumer, retry/DLQ, reconnect. `server/runtime/dispatcher.ts` — цикл outbox.
- `server/broker/redis.ts` — Pub/Sub и token-owned lease.
- `server/runtime/runtime.ts` собирает consumer, dispatcher и realtime; `server/entry/worker.ts` — отдельный worker и его `/health`. Папки: [`docs/structure.md`](docs/structure.md).
- `src/client` + `src/app` — React UI: `pages/` (экраны), `features/` (overview, incidents/analysis, services, rules, operations), `components/` (Dialog, drawers). `tests/unit`, `tests/integration`, `tests/e2e` — уровни тестов. Очистка тестовой БД, очередей и Redis выполняется отдельно и не прерывается ошибкой одного из ресурсов.

Это API + worker с общей БД, ещё не database-per-service платформа. Образ приложения — multi-stage: в runtime попадают production-зависимости, `dist`, `server` и `shared`. Учётные данные Compose — только для локальной разработки. Данные разделены на таблицы; доменная проекция хранится в JSONB. Список инцидентов и аудит отдаются страницами; полный снимок остаётся для совместимости. Нужны retention и архивирование для долгой эксплуатации.

Есть journal/webhook notifications, runbooks (timeout/cancel; compensation откатывает только assign), RBAC при `AUTH_REQUIRED=true`, OpenTelemetry hooks и корреляция по графу зависимостей. Внешний Slack/email — только через HTTPS webhook; saga-оркестратор и HA quorum DLQ — нет. Симуляция не возобновляется после падения процесса; уже принятые события сохраняются. Replay DLQ доступен admin API (`/api/failed-jobs/:id/replay`), отдельного UI-мастера нет.

Документация — [`docs/README.md`](docs/README.md): архитектура, AI, структура репозитория.
