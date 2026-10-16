# Структура репозитория

```
shared/                 контракты API и доменные типы (сервер + UI)
server/
  entry/                точки входа (api, worker, import-sqlite)
  config.ts             конфигурация окружения
  observability/        телеметрия
  http/                 Fastify app, WS, helpers
    routes/             core, operations, ai, simulation
  runtime/              orchestration, health worker, periodic tasks
  domain/               чистая доменная логика
  db/                   PostgreSQL store, migrations/ (001…008)
  broker/               RabbitMQ, Redis
  ai/                   AI-анализ и пост-валидация ответа модели
    validate.ts         контракт + measured-source checks
    claim-numbers.ts    числа ↔ метрики по источникам
    claim-units.ts      allowlist единиц после числа (ms-семейство)
    guards.ts           lexical guards, grounded tokens, numsOf
    context*.ts         бюджет контекста и сбор источников
    service/dispatcher/ очередь и durable jobs
  operations/           runbooks, retention, notifications
  security/             auth, RBAC, actors
src/
  main.tsx
  style.css
  client/               HTTP/WS клиент и session
  app/
    App.tsx             вкладки, shell, диалоги
    lib/                store, formatters
    pages/              экраны (тонкая сборка)
      OverviewPage      OperationsPage  RulesPage
      ServicesPage      ActivityPage    IncidentsTable
    components/         общие оболочки (Dialog, AuthGate, drawers)
      IncidentDrawer    RuleDialog      ActivityRow
    features/           UI по доменным фичам
      overview/         баннер, stats, service health preview, footer
      incidents/        карточка инцидента (header/meta/actions/timeline)
        analysis/       AI-панель: отчёт, postmortem, источники, export
      services/         ServiceCard, Sparkline
      rules/            RuleRow, RuleToggle, footer
      operations/       Failed/Dependencies/Runbooks/Notifications cards, runs
tests/
  unit/                 vitest unit (в т.ч. ai-numbers)
  integration/          vitest + изолированная infra
  e2e/                  Playwright
  support/              фикстуры
docs/                   актуальные документы (см. README.md)
scripts/                CLI-утилиты
infra/                  конфиги postgres/redis/rabbit/nginx/otel
compose.yaml            локальная infra + sentinel/worker
```

## Слои UI

- **`pages/`** — экран целиком: что монтирует `App` по вкладке. Держит layout и прокидывает данные вниз.
- **`features/<domain>/`** — куски экрана и локальные хуки (мутации, AI-query). Не общие примитивы.
- **`components/`** — переиспользуемые оболочки и диалоги без доменной «фичи» в названии.

Форматирование: Prettier (`npx prettier --write .`), конфиг по умолчанию; игнор — `.prettierignore`.
