-- AddForeignKey
ALTER TABLE "assistant_links" ADD CONSTRAINT "assistant_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "assistant_links"("id") ON DELETE SET NULL ON UPDATE CASCADE;
