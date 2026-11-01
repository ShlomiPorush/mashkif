using Mashkif.Common;

namespace Mashkif.Service;

/// <summary>Routes Microsoft.Extensions.Logging output to a <see cref="FileLog"/>.</summary>
internal sealed class FileLoggerProvider(FileLog log) : ILoggerProvider
{
    public ILogger CreateLogger(string categoryName) => new FileLogger(log, categoryName);

    public void Dispose()
    {
    }

    private sealed class FileLogger(FileLog log, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel))
            {
                return;
            }

            ArgumentNullException.ThrowIfNull(formatter);
            var message = formatter(state, exception);
            if (exception is not null)
            {
                message = $"{message} {exception}";
            }

            log.Write(ToLevel(logLevel), $"[{category}] {message}");
        }

        private static string ToLevel(LogLevel level) => level switch
        {
            LogLevel.Trace => "TRACE",
            LogLevel.Debug => "DEBUG",
            LogLevel.Information => "INFO",
            LogLevel.Warning => "WARN",
            LogLevel.Error => "ERROR",
            LogLevel.Critical => "FATAL",
            _ => "INFO",
        };
    }
}
