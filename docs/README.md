# nopCommerce — Observability Assignment

A fork of [nopSolutions/nopCommerce](https://github.com/nopSolutions/nopCommerce) instrumented with OpenTelemetry tracing, Prometheus metrics, and structured logging via Serilog. The instrumented flow is **Customer Places an Order** — from HTTP entry through shopping cart, payment, and inventory adjustment.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Instrumented Flow Diagram](#instrumented-flow-diagram)
3. [Prerequisites](#prerequisites)
4. [Running the Observability Stack](#running-the-observability-stack)
5. [Running the Application](#running-the-application)
6. [Viewing the Dashboard](#viewing-the-dashboard)
7. [Running the Load Test](#running-the-load-test)
8. [Observability Stack Endpoints](#observability-stack-endpoints)
9. [Project Structure](#project-structure)

---

## Architecture Overview

nopCommerce follows an Onion Architecture. The instrumented components sit at every layer boundary — HTTP entry, service calls, and data mutation — following the principle of instrumenting boundaries, not internals.

```
┌─────────────────────────────────────────────────────────────────┐
│                       Nop.Web (HTTP)                            │
│   CheckoutController · OrderController · ShoppingCartController │
│              [AspNetCore auto-instrumentation]                   │
│              [Manual spans at action boundaries]                 │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP root span
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Nop.Services (Business Logic)               │
│   ShoppingCartService · OrderProcessingService                  │
│   PaymentService · ProductService (Inventory)                   │
│              [Manual spans at service entry/exit]               │
│              [Custom metrics: orders.started/failed,            │
│               order.value, inventory.level]                     │
└────────────────────────────┬────────────────────────────────────┘
                             │ Service child spans
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Nop.Data (Persistence)                      │
│              [EF Core auto-instrumentation]                     │
└─────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SQL Server (nopcommerce_mssql_server)         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Instrumented Flow Diagram

The following diagram shows the full trace for a customer placing an order, with span names, the services they originate from, and the metrics recorded at each step.

```
Browser
  │
  │  POST /checkout/confirm
  │
  ▼
┌──────────────────────────────────────────────────────────────────┐
│  SPAN: HTTP POST /checkout/confirm                               │
│  Source: AspNetCore auto-instrumentation                         │
│  Tags: http.method, http.route, http.status_code                 │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  SPAN: ShoppingCart.Get                                    │  │
│  │  Source: ShoppingCartService.GetShoppingCartAsync          │  │
│  │  Tags: customer.id, store.id, shopping.cart.type           │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  SPAN: Payment.Process                                     │  │
│  │  Source: PaymentService.ProcessPaymentAsync                │  │
│  │  Tags: payment.method, order.total                         │  │
│  │  Metric: orders.failed++ (on error)                        │  │
│  │                                                            │  │
│  │    ┌──────────────────────────────────────────────────┐   │  │
│  │    │  SPAN: HTTP client → payment gateway             │   │  │
│  │    │  Source: HttpClient auto-instrumentation         │   │  │
│  │    │  Tags: http.url, http.status_code                │   │  │
│  │    └──────────────────────────────────────────────────┘   │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  SPAN: Inventory.Adjust                                    │  │
│  │  Source: ProductService.AdjustInventoryAsync               │  │
│  │  Tags: product.id, quantity.change, inventory.before       │  │
│  │  Metric: inventory.level recorded                          │  │
│  │                                                            │  │
│  │    ┌──────────────────────────────────────────────────┐   │  │
│  │    │  SPAN: EF Core / SQL — UpdateProductAsync        │   │  │
│  │    │  Source: EF Core auto-instrumentation            │   │  │
│  │    └──────────────────────────────────────────────────┘   │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Metric: orders.started++                                        │
│  Metric: order.value recorded (histogram of OrderTotal)          │
└──────────────────────────────────────────────────────────────────┘

All spans → OTLP/gRPC → Jaeger (port 4317)
All metrics → Prometheus scrape → Grafana
All logs → Serilog → Loki (via Promtail)
```

### PII boundary

`SensitiveDataProcessor` runs at export time and redacts any span tag whose key contains `email`, `password`, `credit`, `card`, `address`, `phone`, `ssn`, or `payment`. No customer email address, billing address, or payment token reaches Jaeger or any other backend.

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Docker Desktop | 4.x+ | Required for the full stack |
| Docker Compose | v2+ | Included with Docker Desktop |
| .NET SDK | 9.0 | Only needed if running the app outside Docker |
| k6 | 0.49+ | Only needed to run the load test locally |

---

## Running the Observability Stack

The observability backend (Jaeger, Prometheus, Grafana, Loki, Promtail) runs independently from the application on a shared Docker network.

**Step 1 — Create the shared network (once only):**

```bash
docker network create nopcommerce_observability
```

**Step 2 — Start the observability stack:**

```bash
docker compose -f observability-docker-compose.yml up -d
```

This starts:

| Container | Purpose | Port |
|---|---|---|
| `jaeger` | Trace collection and UI | `16686` (UI), `4317` (OTLP/gRPC) |
| `prometheus` | Metrics scraping and storage | `9090` |
| `grafana` | Dashboards | `3000` |
| `loki` | Log aggregation | `3100` |
| `promtail` | Docker log collection | — |

Wait approximately 15 seconds for all containers to become healthy before starting the application.

---

## Running the Application

```bash
docker compose -f docker-compose.yml up -d --build
```

This starts:

| Container | Purpose | Port |
|---|---|---|
| `nopcommerce` | The application | `80` |
| `nopcommerce_mssql_server` | SQL Server 2019 Express | — (internal only) |

Both containers join the `nopcommerce_observability` network, which is how the application reaches Jaeger on `http://jaeger:4317`.

**First run only — database initialisation:**

On first startup, nopCommerce will redirect to the installation wizard at `http://localhost/install`. Complete the setup using the pre-configured connection string:

```
Server=nopcommerce_mssql_server;Database=nopCommerce_Database;
User Id=sa;Password=nopCommerce_db_password;TrustServerCertificate=true
```

Once installation is complete, the store is available at `http://localhost`.

---

## Viewing the Dashboard

### Grafana

Open `http://localhost:3000` in your browser.

Default credentials:
- Username: `admin`
- Password: `admin`

**Import the dashboard:**

1. In the left sidebar, click **Dashboards → Import**.
2. Upload the file `grafana/nopcommerce-order-flow.json` from the repository root.
3. Select **Prometheus** as the data source when prompted.
4. Click **Import**.

The dashboard includes the following panels:

| Panel | What it shows |
|---|---|
| Order placement rate | `orders.started` counter — requests entering the checkout pipeline per minute |
| Order failure rate | `orders.failed` / `orders.started` — checkout conversion failure % |
| Order value distribution | `order.value` histogram — P50/P95/P99 of order totals |
| Inventory levels | `inventory.level` histogram — stock quantity by product ID after each adjustment |
| HTTP error rate | 4xx/5xx responses on the checkout flow |
| Request latency | P99 end-to-end latency for the order placement HTTP handler |

### Jaeger (Traces)

Open `http://localhost:16686` in your browser.

1. In the **Service** dropdown, select `nopCommerce`.
2. In the **Operation** dropdown, select `HTTP POST /checkout/confirm` (or any span name from the flow diagram above).
3. Click **Find Traces**.

A trace for a completed order will show the full span hierarchy: HTTP root → ShoppingCart.Get → Payment.Process → Inventory.Adjust → SQL statements.

### Prometheus

Open `http://localhost:9090` in your browser.

Useful queries:

```promql
# Order failure rate over 5-minute windows
rate(orders_failed_total[5m]) / rate(orders_started_total[5m])

# 99th percentile order value
histogram_quantile(0.99, rate(order_value_bucket[5m]))

# Current inventory by product
inventory_level_sum / inventory_level_count
```

---

## Running the Load Test

The load test script (`load_tests/order-flow-test.js`) drives the full order placement flow under load using [k6](https://k6.io).

**Install k6:**

```bash
# macOS
brew install k6

# Windows
choco install k6

# Docker (no install required)
docker run --rm -i grafana/k6 run - < load_tests/order-flow-test.js
```

**Run against the local stack:**

```bash
k6 run \
  --vus 20 \
  --duration 2m \
  load_tests/order-flow-test.js
```

- `--vus 20` — 20 concurrent virtual users
- `--duration 2m` — run for 2 minutes

While the test is running, open the Grafana dashboard (`http://localhost:3000`) to observe metrics responding to the load in real time. Open Jaeger (`http://localhost:16686`) in a second tab to browse traces as they arrive.

**Expected output:**

```
✓ status is 200
✓ transaction time OK

checks.........................: 97.50% ✓ 1950      ✗ 50
data_received..................: 4.2 MB 35 kB/s
data_sent......................: 890 kB 7.4 kB/s
http_req_duration..............: avg=312ms min=89ms med=245ms max=2.1s p(90)=580ms p(95)=820ms
vus............................: 20     min=20     max=20
```

---

## Observability Stack Endpoints

| Service | URL | Credentials |
|---|---|---|
| nopCommerce store | http://localhost | — |
| nopCommerce metrics | http://localhost/metrics | — |
| Grafana | http://localhost:3000 | admin / admin |
| Jaeger UI | http://localhost:16686 | — |
| Prometheus UI | http://localhost:9090 | — |
| Loki | http://localhost:3100 | — |

---

## Project Structure

```
nopCommerce/
├── src/
│   ├── Libraries/
│   │   └── Nop.Services/
│   │       ├── DiagnosticsConfig.cs          # ActivitySource, Meter, custom metrics
│   │       ├── Catalog/ProductService.cs     # Inventory.Adjust span
│   │       ├── Orders/
│   │       │   ├── OrderProcessingService.cs # Order placement spans + metrics
│   │       │   ├── OrderService.cs           # DiagnosticsConfig import
│   │       │   └── ShoppingCartService.cs    # ShoppingCart.Get / Add spans
│   │       └── Payments/PaymentService.cs    # Payment.Process span
│   └── Presentation/
│       └── Nop.Web/
│           ├── Program.cs                    # OTel SDK + Serilog registration
│           ├── SensitiveDataProcessor.cs     # PII redaction before export
│           ├── Nop.Web.csproj                # OTel + Serilog NuGet packages
│           └── Controllers/
│               ├── CheckoutController.cs     # Checkout flow spans
│               ├── OrderController.cs        # Order.Details span
│               └── ShoppingCartController.cs # ShoppingCart.AddToCart span
├── load_tests/
│   └── order-flow-test.js                    # k6 load test script
├── grafana/
│   └── nopcommerce-order-flow.json           # Grafana dashboard export
├── docs/
│   └── Analysis.md                           # Architecture analysis
├── observability-docker-compose.yml          # Jaeger, Prometheus, Grafana, Loki, Promtail
├── docker-compose.yml                        # nopCommerce app + SQL Server
├── prometheus.yml                            # Prometheus scrape configuration
├── promtail-config.yaml                      # Docker log collection configuration
├── CRITIQUE.md                               # Architectural critique
└── README.md                                 # This file
```

---

## Custom Metrics Reference

| Metric | Type | Description | Operational use |
|---|---|---|---|
| `orders.started` | Counter | Incremented at start of order placement | Baseline throughput; flat line under load means the pipeline is not being reached |
| `orders.failed` | Counter | Incremented on payment failure or unhandled exception | `failed/started` ratio is the checkout conversion failure rate; a spike at 2am means the payment gateway is degrading |
| `order.value` | Histogram | Distribution of `OrderTotal` per completed order | Detects pricing bugs (£0.00 orders), monitors revenue throughput, supports SLO-based alerting on checkout value |
| `inventory.level` | Histogram | Stock quantity after each `AdjustInventoryAsync` call | Surfaces stockout risk before it becomes customer-visible; low values on high-volume products should trigger restocking alerts |

---

## Teardown

```bash
# Stop the application
docker compose -f docker-compose.yml down

# Stop the observability stack (data is preserved in named volumes)
docker compose -f observability-docker-compose.yml down

# Stop everything and remove all data
docker compose -f docker-compose.yml down -v
docker compose -f observability-docker-compose.yml down -v
docker network rm nopcommerce_observability
```