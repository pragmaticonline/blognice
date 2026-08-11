declare module "web-push" {
  type VapidDetails = { subject: string; publicKey: string; privateKey: string };
  type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };
  type Options = { TTL?: number; vapidDetails: VapidDetails };
  type Response = { statusCode: number };
  export function sendNotification(subscription: PushSubscription, payload?: string, options?: Options): Promise<Response>;
}
