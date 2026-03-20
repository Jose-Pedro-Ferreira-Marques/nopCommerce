# 1. Read Before You Touch — Architecture Analysis

---

## 1.1 How the Layers Are Organised and the Dependency Rules Between Them

nopCommerce follows an **Onion Architecture** — a layered design where all coupling points inward toward a central core, and outer layers may depend on inner ones but never the reverse. There are four distinct layers:

```
┌──────────────────────────────────────────────┐
│              Presentation Layer               │
│         Nop.Web  |  Nop.Web.Framework         │
├──────────────────────────────────────────────┤
│            Application Core (outer)           │
│                  Nop.Services                 │
├──────────────────────────────────────────────┤
│            Application Core (mid)             │
│                   Nop.Data                    │
├──────────────────────────────────────────────┤
│            Application Core (center)          │
│                   Nop.Core                    │
└──────────────────────────────────────────────┘
```

**Nop.Core** is the innermost ring. It has zero dependencies on any other project in the solution. It defines domain entities (e.g., `Order`, `Customer`, `Product`), caching abstractions, settings classes, and — critically for observability — the event infrastructure (`IEventPublisher`). Everything else can depend on it; it depends on nothing.

**Nop.Data** sits one ring out. It depends only on `Nop.Core`. It owns the data-access layer using Linq2DB with a Code-First approach and FluentMigrator for schema management. Repository types are defined here and injected upward via interfaces. Queries translate to SQL behind the scenes. This layer is the boundary between the database and the rest of the system — a natural instrumentation point for database span creation.

**Nop.Services** is the outermost ring of the Application Core. It depends on both `Nop.Core` and `Nop.Data`. This is where all business logic lives — over 70 service classes covering orders, payments, customers, catalogue, inventory, and more. Services consume repositories via constructor injection and call `IEventPublisher` to broadcast lifecycle events. This layer is where the most meaningful instrumentation points exist.

**Nop.Web.Framework** and **Nop.Web** form the Presentation layer. `Nop.Web` is the composition root — it references `Nop.Data` not for data access, but to wire up dependency injection at startup. Controllers and view components only talk to `Nop.Services`; they never directly call repositories. This is an important observability boundary: the HTTP request enters `Nop.Web`, crosses into `Nop.Services` via constructor-injected service interfaces, and then hits `Nop.Data` for persistence.

**Dependency summary:**

| Layer | Depends on |
|---|---|
| `Nop.Core` | Nothing |
| `Nop.Data` | `Nop.Core` |
| `Nop.Services` | `Nop.Core`, `Nop.Data` |
| `Nop.Web.Framework` | `Nop.Services`, `Nop.Core`, `Nop.Data` |
| `Nop.Web` | All of the above (composition root) |

The plugin system sits orthogonally to this. Plugins can implement service interfaces and are resolved by the DI container at runtime. They share the same `DbContext` as the core application if they use core repositories, which means a plugin-based `IConsumer<T>` implementation is a legitimate, non-invasive extension point for instrumentation consumers.

---

## 1.2 How nopCommerce Handles Events Internally — What Is `IEventPublisher` and How Is It Used?

nopCommerce ships its own in-process event bus, implemented around three interfaces defined in `Nop.Core`:

- **`IEventPublisher`** — the producer side. Any service that needs to announce a lifecycle event injects this interface and calls `PublishAsync<T>(T eventMessage)`.
- **`IConsumer<T>`** — the consumer side. Any class that implements this interface and is registered in the DI container will have `HandleEventAsync(T eventMessage)` invoked whenever a matching event is published.
- **`ISubscriptionService`** — resolves all registered `IConsumer<T>` implementations for a given event type. nopCommerce uses reflection to discover and register consumers automatically at startup.

There are three built-in extension methods on `IEventPublisher` that cover the most common cases:

```csharp
await _eventPublisher.EntityInsertedAsync<T>(entity);
await _eventPublisher.EntityUpdatedAsync<T>(entity);
await _eventPublisher.EntityDeletedAsync<T>(entity);
```

These wrap the entity in typed event objects (`EntityInsertedEvent<T>`, `EntityUpdatedEvent<T>`, `EntityDeletedEvent<T>`) and broadcast to all matching consumers.

Custom domain events are also supported. For example, `OrderService` publishes:

```csharp
await _eventPublisher.PublishAsync(new OrderPlacedEvent(order));
```

Any class implementing `IConsumer<OrderPlacedEvent>` will receive this event.

**Why this matters for observability:** `IEventPublisher` is a synchronous, in-process mediator — not a message broker. There is no automatic trace context propagation across event boundaries. When `OrderService` fires `OrderPlacedEvent`, the consumer runs in the same thread/async context, but if the consumer is invoked indirectly through the subscription service, the `Activity` context may not propagate correctly unless explicitly managed. This means event-driven side effects (sending emails, updating inventory counters) can silently break out of the active trace unless instrumentation accounts for this.

The event system is an excellent instrumentation boundary precisely because it marks meaningful domain transitions — an order being placed, a product being inserted, a payment being processed. Wrapping consumer invocations with child spans gives an operator visibility into what side-effects fire and how long they take.

---

## 1.3 Where the Code Makes Observability Easy — and Where It Makes It Hard

### Where it is easy

**ASP.NET Core middleware pipeline.** `Nop.Web` is a standard ASP.NET Core application. The `OpenTelemetry.Instrumentation.AspNetCore` package instruments all incoming HTTP requests automatically, providing the root span for every user-facing operation. No changes to the codebase are needed for this layer.

**HttpClient usage.** Where nopCommerce makes outbound HTTP calls (e.g., to payment gateways), `OpenTelemetry.Instrumentation.Http` will automatically create child spans and inject W3C `traceparent` headers for context propagation.

**Database access via Linq2DB.** While there is no official OTel instrumentation library for Linq2DB (unlike Entity Framework Core), the repository pattern means all database calls are centralised in `Nop.Data`. A single `ActivitySource` placed at the repository boundary can cover every data access operation without scattering instrumentation across dozens of service classes.

**Constructor injection throughout.** The entire codebase is built on ASP.NET Core's DI container. This makes it straightforward to register a singleton `ActivitySource` and `Meter` and inject them wherever instrumentation is needed — including into services, consumers, and controllers — without structural changes.

**`IEventPublisher` as a natural span boundary.** Every meaningful domain action publishes an event after it completes. Wrapping `PublishAsync` calls or `HandleEventAsync` invocations with child spans is clean and non-invasive.

### Where it is hard

**No built-in OTel support.** nopCommerce ships with zero OpenTelemetry instrumentation. There is no `ActivitySource` in `Nop.Services`, no `Meter` registrations, and no OTLP exporter configuration. Everything must be added.

**Thick service classes.** Some service classes in `Nop.Services` (e.g., `OrderService`, `ShoppingCartService`) contain thousands of lines of business logic mixing orchestration, validation, calculation, and persistence. There is no clear internal boundary within a service where a span naturally starts and stops. Over-instrumenting these classes risks creating noisy, low-value spans; under-instrumenting them leaves critical operations invisible.

**In-process event bus breaks trace context.** As described above, the subscription service dispatches consumers without any OTel-aware context propagation. A span started in `OrderService.PlaceOrderAsync` will not automatically become the parent of a span started inside `OrderPlacedEvent`'s consumer, because the subscription service resolves and invokes consumers through reflection without carrying the `Activity` context explicitly. This requires a deliberate fix at the `EventPublisher` level.

**Sensitive data in service method parameters.** `Nop.Services.Orders.OrderService` and `Nop.Services.Customers.CustomerService` pass around objects containing emails, billing addresses, and payment tokens. Naively tagging span attributes from these objects would leak PII into the trace backend. There is no sanitisation layer today — any PII exclusion must be added explicitly, either via an OTel processor or by carefully selecting which fields are tagged.

**Caching layer opacity.** nopCommerce uses a distributed and in-memory cache aggressively. Cache hits and misses are invisible without instrumentation, but the caching service is called from within `Nop.Services` methods, making it difficult to know from a trace whether a slow response was a cache miss followed by a slow query, or simply a slow query every time.

**Plugin resolution at startup.** Plugins are loaded dynamically. If any instrumentation code is placed inside plugin assemblies, the `ActivitySource` name must be explicitly registered with the `TracerProvider` at startup — otherwise, spans from that source will be silently dropped.

---

## 1.4 What Structural Changes Are Needed — and Are They Worth Making?

### Changes required

**1. Register a centralised `ActivitySource` and `Meter`.**
A new `NopInstrumentation` class should be created — ideally in `Nop.Web` or a dedicated `Nop.Observability` project — holding a static `ActivitySource` and a `Meter`. These are registered as singletons in DI and injected into the services that need them. This is an additive change; no existing code needs to be modified.

**2. Patch `EventPublisher` to propagate trace context.**
`EventPublisher.PublishAsync<T>` currently has no awareness of `Activity`. A minimal surgical change — capturing `Activity.Current` before dispatching to consumers and restoring it inside the dispatch loop — ensures that consumer spans appear as children of the publishing span. The change is localised to a single method in `Nop.Core`.

**3. Add an OTel span processor for PII sanitisation.**
Rather than trying to remember which fields to exclude at every instrumentation site, a single `BaseProcessor<Activity>` that scrubs known sensitive attribute names (`customer.email`, `order.billing_address`, etc.) before export is both safer and easier to maintain. This is registered once in `Program.cs` / `Startup.cs`.

**4. Configure the OTel SDK in `Program.cs`.**
nopCommerce's `Program.cs` / `Startup.cs` is the composition root. Adding `services.AddOpenTelemetry()` with `AddAspNetCoreInstrumentation()`, `AddHttpClientInstrumentation()`, `AddSqlClientInstrumentation()` (or a custom Linq2DB bridge), and an OTLP exporter is a contained change in one file.

### Are these changes worth making?

Yes — and the cost is deliberately bounded. The ASP.NET Core and HttpClient layers give automatic coverage of the entry point and outbound calls at zero code change cost. The `EventPublisher` patch is a five-line change in a single method that eliminates a structural blind spot in the trace graph. The PII processor is a safety net that prevents a class of production incidents. None of these changes touch business logic; they are all infrastructure-boundary concerns.

The one category of change that is *not* worth making is refactoring service classes to improve their internal observability. `OrderService` could in principle be decomposed into smaller units to make instrumentation points cleaner, but that is a significant refactoring risk for a benefit that can be achieved more cheaply by instrumenting at the entry and exit of the service method, and at the `IEventPublisher` dispatch boundary, rather than at every internal step.

The architect's rule here is: **instrument the boundaries, not the internals.** HTTP in, event dispatch, and database out are sufficient to tell a coherent operational story without requiring structural surgery on the codebase.