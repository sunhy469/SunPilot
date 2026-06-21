export interface WorldNodeRecord {
  id: string;
  type: string;
  name: string;
  posX: number;
  posY: number;
  sizeWidth: number;
  sizeHeight: number;
  icon?: string;
  logo?: string;
  enabled: boolean;
  createdAt: string;
}

export interface CreateWorldNodeInput {
  id?: string;
  type: string;
  name: string;
  posX: number;
  posY: number;
  sizeWidth: number;
  sizeHeight: number;
  icon?: string;
  logo?: string;
  enabled?: boolean;
}

export interface WorldNodeRepository {
  create(input: CreateWorldNodeInput): Promise<WorldNodeRecord>;
  findById(id: string): Promise<WorldNodeRecord | null>;
  list(): Promise<WorldNodeRecord[]>;
  update(id: string, patch: Partial<CreateWorldNodeInput>): Promise<WorldNodeRecord | null>;
  delete(id: string): Promise<boolean>;
}
