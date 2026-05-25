export type TypedFilterQuery<Fields extends string> = {
  filter?: {
    [K in Fields]?: unknown | Record<string, unknown>;
  };
  include?: string[];
  search?: string;
  sort?: Array<{ field: Fields; direction: 'asc' | 'desc' }>;
  paginate?: { page: number; size: number };
};
