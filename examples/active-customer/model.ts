export type Customer = {
  status: "active" | "suspended";
  deletedAt: string | null;
  email: string | null | undefined;
};
