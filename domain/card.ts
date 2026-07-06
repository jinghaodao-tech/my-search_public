export interface Card {
  id:          string;
  title:       string;
  body:        string;
  summary?:    string;       // AI要約
  url?:        string;
  tags:        string[];     // タグ一覧
  links:       string[];     // Zettelkasten リンク先カードID
  kjGroupId?:  string;       // KJ法グループID
  type:        'article' | 'memo' | 'csv';
  color?:      string;       // カード色 (例: '#FFD700')
  archived?:   boolean;
  archivedAt?: string;
  createdAt:   string;       // ISO文字列
  updatedAt:   string;
  tokens?:     string[];
  docLength?:  number;
}
