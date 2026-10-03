import { SignupForm } from "./form";

export const dynamic = "force-dynamic";
/** Self-service signup: a new isolated business; modules start only after a verified payment. */
export default function SignupPage() {
  return (
    <main dir="rtl" className="mx-auto max-w-md p-5" data-testid="signup">
      <h1 className="text-2xl font-bold">הרשמה ל-Solina CRM</h1>
      <p className="text-sm text-gray-600 mt-1">עסק חדש ומבודד. מודולים (CRM, חייגן ו-AI, WhatsApp, דיוור) נפתחים אחרי בחירה ותשלום מאומת.</p>
      <SignupForm />
    </main>
  );
}
