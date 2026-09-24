"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Ltr } from "@/components/shared/ltr";
import { EmptyState } from "@/components/shared/empty-state";
import { NewContactDialog } from "./new-contact-dialog";

interface ContactRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  consentStatus: string;
  conversations?: { assignedAgent: { name: string } | null }[];
  tags: { tag: { id: string; name: string } }[];
}

const CONSENT_LABELS: Record<string, string> = {
  OPTED_IN: "הסכים",
  OPTED_OUT: "סירב",
  UNKNOWN: "לא ידוע",
};

export function ContactTable({ initialContacts, canExport = false }: { initialContacts: ContactRow[]; canExport?: boolean }) {
  const [contacts, setContacts] = useState(initialContacts);
  const [search, setSearch] = useState("");

  const searchRequest = useRef(0);
  async function handleSearch(value: string) {
    setSearch(value);
    const requestId = ++searchRequest.current;
    try {
      const res = await fetch(`/api/contacts?search=${encodeURIComponent(value)}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (requestId === searchRequest.current) setContacts(data.contacts);
    } catch { if (requestId === searchRequest.current) toast.error("החיפוש נכשל. מוצגות התוצאות האחרונות"); }
  }

  return (
    <div className="flex h-full flex-col p-6">
      <div className="mb-4 flex items-center justify-between gap-4">
        <Input
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="חיפוש לפי שם, טלפון או אימייל..."
          className="max-w-sm"
        />
        {canExport && <a className="whitespace-nowrap text-sm underline" href={`/api/contacts/export?search=${encodeURIComponent(search)}`}>ייצוא CSV</a>}
        <NewContactDialog />
      </div>

      {contacts.length === 0 ? (
        <EmptyState title="אין אנשי קשר להצגה" description="נסה לשנות את החיפוש או להוסיף איש קשר חדש." />
      ) : (
        <div className="overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>שם</TableHead>
                <TableHead>טלפון</TableHead>
                <TableHead>אימייל</TableHead>
                <TableHead>תגיות</TableHead>
                <TableHead>נציג מטפל</TableHead><TableHead>הסכמה</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contacts.map((contact) => (
                <TableRow key={contact.id} className="cursor-pointer">
                  <TableCell>
                    <Link href={`/contacts/${contact.id}`} className="font-medium hover:underline">
                      {contact.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Ltr>{contact.phone}</Ltr>
                  </TableCell>
                  <TableCell>
                    <Ltr>{contact.email ?? "—"}</Ltr>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {contact.tags.map(({ tag }) => (
                        <Badge key={tag.id} variant="outline">
                          {tag.name}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>{contact.conversations?.[0]?.assignedAgent?.name ?? "לא משויך"}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{CONSENT_LABELS[contact.consentStatus] ?? contact.consentStatus}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
