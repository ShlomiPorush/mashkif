using Polly;
using Polly.Retry;

namespace Mashkif.Service.Agent;

/// <summary>What happens after one attempt.</summary>
internal enum StepKind
{
    /// <summary>Success; the caller continues (a heartbeat waits for its interval).</summary>
    Done,

    /// <summary>Finished without success; nothing to wait for (identity or registration dropped, or replaced).</summary>
    Stop,

    /// <summary>Try again after the exponential backoff with jitter.</summary>
    Retry,

    /// <summary>Try again after <see cref="Step.Delay"/> (a 429 <c>Retry-After</c>, or 0 to retry at once).</summary>
    RetryAfter,

    /// <summary>Try again in about an hour (redirects, refused requests, a rejected token).</summary>
    Slow,
}

/// <summary>The outcome of one attempt, as the retry pipeline sees it.</summary>
internal readonly record struct Step(StepKind Kind, TimeSpan Delay = default)
{
    public static Step Done => new(StepKind.Done);

    public static Step Stop => new(StepKind.Stop);

    public static Step Retry => new(StepKind.Retry);

    public static Step Slow => new(StepKind.Slow);

    public static Step After(TimeSpan delay) => new(StepKind.RetryAfter, delay);
}

/// <summary>
/// Retry pipelines (Polly): exponential backoff with jitter, unlimited
/// attempts, cancellable. A <c>Retry-After</c> or the hourly delay replaces
/// the backoff for that attempt.
/// </summary>
internal static class RetryPolicies
{
    /// <summary>First backoff delay of registrations and heartbeats.</summary>
    public static readonly TimeSpan BaseDelay = TimeSpan.FromSeconds(5);

    /// <summary>Longest backoff of a registration.</summary>
    public static readonly TimeSpan RegisterMaxDelay = TimeSpan.FromMinutes(15);

    /// <summary>The slow retry delay, before its jitter.</summary>
    public static readonly TimeSpan SlowDelay = TimeSpan.FromHours(1);

    /// <summary>Most jitter added to the slow retry delay.</summary>
    public static readonly TimeSpan SlowJitter = TimeSpan.FromMinutes(5);

    public static ResiliencePipeline<Step> Create(TimeSpan maxDelay, TimeProvider time) =>
        new ResiliencePipelineBuilder<Step> { TimeProvider = time }
            .AddRetry(new RetryStrategyOptions<Step>
            {
                MaxRetryAttempts = int.MaxValue,
                BackoffType = DelayBackoffType.Exponential,
                UseJitter = true,
                Delay = BaseDelay,
                MaxDelay = maxDelay,
                ShouldHandle = static args => ValueTask.FromResult(
                    args.Outcome.Exception is null
                    && args.Outcome.Result.Kind is StepKind.Retry or StepKind.RetryAfter or StepKind.Slow),
                DelayGenerator = static args => ValueTask.FromResult<TimeSpan?>(args.Outcome.Result.Kind switch
                {
                    StepKind.RetryAfter => args.Outcome.Result.Delay,
                    StepKind.Slow => SlowDelay + (SlowJitter * Random.Shared.NextDouble()),
                    _ => null,
                }),
            })
            .Build();
}
