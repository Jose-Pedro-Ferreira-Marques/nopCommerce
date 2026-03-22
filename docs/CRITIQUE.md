# CRITIQUE.md 

---

## What in nopCommerce's Design Helped or Hindered the Instrumentation Work

### What helped

**Constructor injection everywhere.** The entire codebase is built on ASP.NET Core's DI container with no service locator patterns in the hot paths. Registering a singleton `ActivitySource` and `Meter` in `Program.cs` and letting the container deliver them to any class that needs them was frictionless. There was no global state to work around, no static factories to replace — just constructor parameters to add.

**The repository pattern centralises data access.** All database operations flow through repository types defined in `Nop.Data`. This meant a single instrumentation point at the repository boundary could, in principle, cover every data operation in the system without scattering `StartActivity` calls across dozens of service files. Even though this implementation chose to instrument at the service boundary instead, the pattern made the choice available.

**`IEventPublisher` is a semantic map of the domain.** Every meaningful domain state transition — an order placed, a payment processed, inventory adjusted — publishes an event. This is nopCommerce's own articulation of what matters in the system, and it happens to be exactly the set of things worth tracing. An instrumented `IEventPublisher` dispatch loop would produce a span for every side-effect triggered by an order without touching any business logic. The event bus did more design work for observability than any explicit hook the framework could have provided.

**Standard ASP.NET Core application model.** `Nop.Web` is a vanilla ASP.NET Core host. `OpenTelemetry.Instrumentation.AspNetCore` works on it without modification, providing automatic root spans for every HTTP request. The HTTP layer required zero manual instrumentation.

### What hindered

**Thick service classes with no internal boundaries.** `OrderProcessingService` runs to over two thousand lines and mixes orchestration, validation, calculation, and persistence inside a single class. There is no natural sub-boundary within the method where a span cleanly starts and stops. The consequence is a trace that correctly shows the service was called and whether it succeeded, but cannot distinguish — without reading the error message — between a failure at the payment step and a failure at the inventory reservation step. A more decomposed service class would produce richer traces at no additional instrumentation cost.

**No built-in OTel support means establishing conventions from scratch.** nopCommerce ships with zero telemetry infrastructure. There is no precedent in the codebase for `ActivitySource` naming conventions, span attribute schemas, or metric naming. Every decision — what to name a span, what tags to attach, what constitutes a "meaningful" operation — had to be made from first principles. In a project with even basic OTel scaffolding already present, this cost disappears.

**The in-process event bus silently breaks trace context.** `ISubscriptionService` resolves and invokes consumers via reflection without any awareness of `Activity.Current`. A span started in `OrderProcessingService` does not automatically become the parent of a span started inside an `OrderPlacedEvent` consumer. The consumer span appears in Jaeger as a disconnected root span, making side-effects look like independent operations rather than consequences of the order placement. This is not visible as an error — it is a silent structural gap that only becomes apparent when you try to follow a trace end-to-end and notice a span is missing.

**Sensitive data is close to the surface.** `OrderProcessingService` and `CustomerService` pass around objects containing email addresses, billing addresses, and payment tokens. The natural instinct when adding span attributes is to tag fields that identify the operation — customer ID, order total, product SKU — but the objects in scope also contain fields that must never reach a trace backend. There is no sanitisation layer in the codebase, so every tagging decision required checking what else was on the object being tagged.

---

## What Would Change Architecturally to Make the System More Observable — and at What Cost

**Priority 1 — Patch `EventPublisher.PublishAsync<T>` for trace context propagation.**
This is five lines of code in a single method in `Nop.Core`. Capture `Activity.Current` before the consumer dispatch loop; restore it as the parent activity inside each invocation. The cost is negligible. The benefit is that the trace graph becomes structurally complete: every side-effect triggered by a domain event appears as a child span of the operation that caused it, not as a phantom root. Without this change, the trace for an order placement is missing everything that happens after the `OrderPlacedEvent` fires — email dispatch, inventory reservation, loyalty points — which is most of the interesting work.

```csharp
// EventPublisher.cs — the fix in its entirety
public async Task PublishAsync<T>(T eventMessage)
{
    var parentActivity = Activity.Current; // capture before dispatch
    var consumers = _subscriptionService.GetSubscriptions<T>();
    foreach (var consumer in consumers)
    {
        Activity.Current = parentActivity; // restore for each consumer
        await consumer.HandleEventAsync(eventMessage);
    }
}
```

**Priority 2 — Move `DiagnosticsConfig` to `Nop.Core`.**
The current implementation places `DiagnosticsConfig` in `Nop.Services`. This means the presentation layer references a services-namespace symbol for something that has no business logic in it. The Onion Architecture rule — outer rings may depend on inner ones, not the reverse — is not violated here because `Nop.Web` already depends on `Nop.Services`, but it is still the wrong conceptual home. `Nop.Core` is where all cross-cutting infrastructure lives; moving `DiagnosticsConfig` there costs nothing and restores architectural clarity.

**Priority 3 — Replace `InventoryLevel` histogram with an `ObservableGauge`.**
A `Histogram<int>` records the statistical distribution of observed values — appropriate for durations, sizes, and rates. Current stock quantity is a point-in-time scalar. The correct metric type is `ObservableGauge<int>`, which Prometheus scrapes on demand and which supports alert rules of the form `inventory_level{product_id="42"} < 5`. The histogram will produce misleading percentile panels in Grafana and will not support the stockout-alerting use case that motivated adding the metric in the first place.

**Priority 4 — Introduce an `IObservabilityContext` abstraction.**
The current `DiagnosticsConfig` is a static class. This is pragmatic but makes the telemetry infrastructure impossible to swap or mock in unit tests — any test that exercises a method containing `DiagnosticsConfig.ActivitySource.StartActivity(...)` will either produce real spans (noisy) or need a real `ActivitySource` registered somewhere. Wrapping `ActivitySource` and `Meter` behind an `IObservabilityContext` interface, registered as a singleton in DI, costs one interface file and one registration line, and makes every instrumented method independently testable.

**What is not worth changing — service class decomposition.**
`OrderProcessingService` could in principle be refactored into smaller orchestration units to produce cleaner span boundaries. This would be a significant change to business logic with substantial regression risk. The same observability outcome — knowing the order placement succeeded or failed, and how long it took — is already achieved by instrumenting the service method boundary. The trace does not need to show every internal step; it needs to show every external effect. The `IEventPublisher` fix above delivers the external effects. The refactoring is not worth the risk.

---

## Where Surgical Changes Were Made to Existing Code — and Why They Were Necessary

Three categories of change touched existing files rather than adding new ones.

**`Program.cs` — OTel SDK and Serilog registration.**
This was unavoidable. The OTel `TracerProvider` and `MeterProvider` must be configured at the composition root before the application starts handling requests. There is no way to add an OTLP exporter, a Prometheus scraping endpoint, or a PII processor without modifying `Program.cs`. The change was kept minimal: no changes to the middleware pipeline, no changes to how services are registered, only the addition of `builder.Services.AddOpenTelemetry(...)` and `builder.Host.UseSerilog(...)`. The startup structure is otherwise identical to the original.

**`Nop.Web.csproj` — NuGet package references.**
Adding OTel and Serilog packages required modifying the project file. This is a pure addition with no risk to existing behaviour. The packages chosen (`OpenTelemetry.Instrumentation.AspNetCore`, `.Http`, `.EntityFrameworkCore`, `Serilog.AspNetCore`, and related sinks) are all stable, widely used, and non-invasive. They instrument via middleware and activity listeners, not by patching method bodies.

**Service and controller methods — span wrappers.**
`PaymentService.ProcessPaymentAsync`, `ShoppingCartService.GetShoppingCartAsync`, `ShoppingCartService.AddToCartAsync`, `ProductService.AdjustInventoryAsync`, `OrderController.Details`, and `ShoppingCartController.AddProductToCart_Details` each received a `using var activity = DiagnosticsConfig.ActivitySource.StartActivity(...)` wrapper. In every case the instrumentation was added at the outermost boundary of the method — before the first `ArgumentNullException.ThrowIfNull` check, not inside any conditional branch. The business logic inside each method is unchanged. The exception handling added around these methods (`catch (Exception ex) { activity?.SetStatus(...); throw; }`) re-throws unconditionally, so no error behaviour was altered.

The impact was minimised by following one rule throughout: **add a wrapper, never modify the interior.** If a method's interior needed to change to make it observable, that was treated as a signal to find a different instrumentation point, not to proceed with the interior change.