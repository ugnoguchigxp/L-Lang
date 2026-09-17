export interface ReviewRoutingInput {
  region: "日本" | "海外";
  identityVerified: boolean;
  review?: "承認" | "却下" | null | undefined;
}

export function canProceedWithReview(input: ReviewRoutingInput): boolean {
  return (
    (input.region === "日本" && input.identityVerified === true) ||
    input.review === "承認"
  );
}
