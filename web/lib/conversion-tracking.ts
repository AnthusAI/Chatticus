export type ConversionEventName = "contact_services" | "contact_training";

type TrackConversionFn = (eventName: ConversionEventName) => void;

let trackConversionImpl: TrackConversionFn = (eventName) => {
  console.log(eventName);
};

/** Test-only hook to observe conversion events without console output. */
export function setTrackConversionForTests(source: TrackConversionFn | null): void {
  trackConversionImpl = source ?? ((eventName) => console.log(eventName));
}

export function trackConversion(eventName: ConversionEventName): void {
  trackConversionImpl(eventName);
}
