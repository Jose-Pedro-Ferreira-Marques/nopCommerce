using OpenTelemetry;
using System.Diagnostics;

public class SensitiveDataProcessor : BaseProcessor<Activity>
{
    private static readonly string[] SensitiveKeys = new[]
    {
        "email", "password", "credit", "card", "address", "phone", "ssn", "payment"
    };

    public override void OnEnd(Activity activity)
    {
        foreach (var tag in activity.TagObjects.ToList())
        {
            if (SensitiveKeys.Any(key => tag.Key.Contains(key, StringComparison.OrdinalIgnoreCase)))
            {
                activity.SetTag(tag.Key, "[REDACTED]");
            }
        }
    }
}