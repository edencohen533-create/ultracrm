export function AccessDenied() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <h1 className="text-lg font-semibold">אין לך הרשאה לצפות בעמוד זה</h1>
      <p className="text-sm text-muted-foreground">
        פנה למנהל המערכת אם אתה סבור שזו טעות.
      </p>
    </div>
  );
}
