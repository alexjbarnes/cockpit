"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

export function AuthGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    fetch("/api/auth/check")
      .then((res) => {
        if (!res.ok) {
          router.replace("/login");
        } else {
          setChecked(true);
        }
      })
      .catch(() => {
        router.replace("/login");
      });
  }, [router]);

  if (!checked) return null;
  return <>{children}</>;
}
