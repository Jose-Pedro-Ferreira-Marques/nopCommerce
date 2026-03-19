using System.Diagnostics;
using System.Diagnostics.Metrics;

namespace Nop.Services
{
    public static class DiagnosticsConfig
    {
        public const string ServiceName = "nopCommerce";
        public static readonly ActivitySource ActivitySource = new(ServiceName + ".OrderFlow");
        public static readonly Meter Meter = new(ServiceName + ".OrderMetrics");

        // Custom metrics
        public static Counter<int> OrdersStarted = Meter.CreateCounter<int>(
            "orders.started", 
            description: "Number of order placements started");
            
        public static Histogram<double> OrderValue = Meter.CreateHistogram<double>(
            "order.value", 
            unit: "currency", 
            description: "Total value of placed orders");
            
        public static Counter<int> OrdersFailed = Meter.CreateCounter<int>(
            "orders.failed", 
            description: "Number of failed order placements");

        // NEW METRIC FOR INVENTORY
        public static Histogram<int> InventoryLevel = Meter.CreateHistogram<int>(
            "inventory.level", 
            unit: "items", 
            description: "Current inventory level for products");
    }
}