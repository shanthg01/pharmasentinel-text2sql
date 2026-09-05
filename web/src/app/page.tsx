import { redirect } from "next/navigation";

// "/" has no content of its own — Chat is the default tab.
export default function Home() {
  redirect("/chat");
}
