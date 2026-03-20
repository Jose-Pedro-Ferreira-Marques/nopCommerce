using Autofac.Extensions.DependencyInjection;
using Nop.Core.Configuration;
using Nop.Core.Infrastructure;
using Nop.Web.Framework.Infrastructure.Extensions;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using OpenTelemetry.Exporter;
using Nop.Services;
using Serilog;

namespace Nop.Web;

public partial class Program
{
    public static async Task Main(string[] args)
    {
        // CONFIGURE SERILOG (WITHOUT WithSpan)
        Log.Logger = new LoggerConfiguration()
            .MinimumLevel.Information()
            .MinimumLevel.Override("Microsoft", Serilog.Events.LogEventLevel.Warning)
            .MinimumLevel.Override("Microsoft.AspNetCore", Serilog.Events.LogEventLevel.Warning)
            .Enrich.WithProperty("Service", "nopCommerce")
            .Enrich.WithEnvironmentName()
            .WriteTo.Console(outputTemplate: "[{Timestamp:HH:mm:ss} {Level:u3}] {SourceContext} {Message:lj}{NewLine}{Exception}")
            .WriteTo.File("logs/nopcommerce-.log", 
                rollingInterval: RollingInterval.Day,
                outputTemplate: "{Timestamp:yyyy-MM-dd HH:mm:ss.fff zzz} [{Level:u3}] {SourceContext} {Message:lj}{NewLine}{Exception}")
            .CreateLogger();

        try
        {
            Log.Information("Starting nopCommerce application...");
            
            var builder = WebApplication.CreateBuilder(args);

            // ADD SERILOG TO BUILDER
            builder.Host.UseSerilog();

            builder.Configuration.AddJsonFile(NopConfigurationDefaults.AppSettingsFilePath, true, true);
            if (!string.IsNullOrEmpty(builder.Environment?.EnvironmentName))
            {
                var path = string.Format(NopConfigurationDefaults.AppSettingsEnvironmentFilePath, builder.Environment.EnvironmentName);
                builder.Configuration.AddJsonFile(path, true, true);
            }
            builder.Configuration.AddEnvironmentVariables();

            //load application settings
            builder.Services.ConfigureApplicationSettings(builder);

            // ADD OPENTELEMETRY HERE
            builder.Services.AddOpenTelemetry()
                .WithTracing(tracing =>
                {
                    tracing.AddSource("nopCommerce.OrderFlow")
                        .AddSource("nopCommerce.Catalog")
                        .AddSource(DiagnosticsConfig.ActivitySource.Name)
                        .SetResourceBuilder(ResourceBuilder.CreateDefault()
                            .AddService("nopCommerce", serviceVersion: "1.0.0"))
                        .AddAspNetCoreInstrumentation(options =>
                        {
                            options.RecordException = true;
                            options.Filter = (context) => 
                                !context.Request.Path.StartsWithSegments("/health") &&
                                !context.Request.Path.StartsWithSegments("/metrics");
                        })
                        .AddHttpClientInstrumentation()
                        .AddEntityFrameworkCoreInstrumentation(options =>
                        {
                            options.SetDbStatementForText = true;
                        })
                        .AddProcessor(new SensitiveDataProcessor())
                        .AddOtlpExporter(options =>
                        {
                            options.Endpoint = new Uri("http://jaeger:4317");
                            options.Protocol = OpenTelemetry.Exporter.OtlpExportProtocol.Grpc;
                        });
                })
                .WithMetrics(metrics =>
                {
                    metrics.AddAspNetCoreInstrumentation()
                           .AddHttpClientInstrumentation()
                           .AddMeter("nopCommerce.OrderMetrics")
                           .AddPrometheusExporter();
                });

            var appSettings = Singleton<AppSettings>.Instance;
            var useAutofac = appSettings.Get<CommonConfig>().UseAutofac;

            if (useAutofac)
                builder.Host.UseServiceProviderFactory(new AutofacServiceProviderFactory());
            else
            {
                builder.Host.UseDefaultServiceProvider(options =>
                {
                    options.ValidateScopes = false;
                    options.ValidateOnBuild = true;
                });
            }

            //add services to the application and configure service provider
            builder.Services.ConfigureApplicationServices(builder);

            var app = builder.Build();

            // ADD PROMETHEUS ENDPOINT
            app.UseOpenTelemetryPrometheusScrapingEndpoint();

            // ADD SERILOG REQUEST LOGGING
            app.UseSerilogRequestLogging(options =>
            {
                options.MessageTemplate = "HTTP {RequestMethod} {RequestPath} responded {StatusCode} in {Elapsed:0.0000} ms";
            });

            //configure the application HTTP request pipeline
            app.ConfigureRequestPipeline();
            await app.PublishAppStartedEventAsync();

            Log.Information("nopCommerce started successfully");

            await app.RunAsync();
        }
        catch (Exception ex)
        {
            Log.Fatal(ex, "Application terminated unexpectedly");
            throw;
        }
        finally
        {
            Log.CloseAndFlush();
        }
    }
}