import { emailDesignSchema, type EmailDesign } from "@/lib/email/blocks";

/** Ready-made starting points for the email builder ("תבניות מוכנות"). Plain content – the user replaces every text. */
export const EMAIL_STARTERS: Array<{ key: string; name: string; description: string; design: EmailDesign }> = [
  { key: "announcement", name: "הודעה פשוטה", description: "כותרת, פסקה וכפתור אחד", design: emailDesignSchema.parse({ blocks: [
    { type: "heading", text: "שלום {{first_name|לקוח יקר}}," },
    { type: "text", text: "יש לנו חדשות בשבילך. כאן כותבים את ההודעה במשפט או שניים ברורים." },
    { type: "button", text: "לפרטים נוספים", href: "https://example.com" },
    { type: "footer", text: "שם העסק · כתובת · טלפון" },
  ] }) },
  { key: "promo", name: "מבצע", description: "תמונה גדולה, כותרת מבצע, כפתור ורשתות חברתיות", design: emailDesignSchema.parse({ blocks: [
    { type: "image", src: "https://placehold.co/600x260/111111/ffffff?text=%D7%9E%D7%91%D7%A6%D7%A2", alt: "מבצע" },
    { type: "heading", text: "המבצע שחיכית לו", align: "center" },
    { type: "text", text: "עד סוף השבוע: תיאור קצר של ההטבה ומה צריך לעשות כדי לקבל אותה.", align: "center" },
    { type: "button", text: "אני רוצה", href: "https://example.com" },
    { type: "spacer", height: 16 },
    { type: "social", links: [{ network: "facebook", href: "https://facebook.com/" }, { network: "instagram", href: "https://instagram.com/" }, { network: "whatsapp", href: "https://wa.me/972500000000" }], align: "center" },
    { type: "footer", text: "שם העסק · כתובת · טלפון" },
  ] }) },
  { key: "newsletter", name: "ניוזלטר", description: "פתיח, שלוש עמודות תוכן ומפריד", design: emailDesignSchema.parse({ blocks: [
    { type: "heading", text: "העדכון החודשי" },
    { type: "text", text: "שלום {{first_name|לקוח יקר}}, הנה מה שחדש אצלנו החודש." },
    { type: "divider" },
    { type: "columns", items: [{ title: "חדש", text: "משפט אחד על הנושא הראשון.", src: "https://placehold.co/180x120", href: "https://example.com" }, { title: "טיפ", text: "משפט אחד על הנושא השני.", src: "https://placehold.co/180x120", href: "https://example.com" }, { title: "בקרוב", text: "משפט אחד על הנושא השלישי.", src: "https://placehold.co/180x120", href: "https://example.com" }] },
    { type: "spacer", height: 12 },
    { type: "button", text: "לכל העדכונים", href: "https://example.com" },
    { type: "footer", text: "שם העסק · כתובת · טלפון" },
  ] }) },
];
