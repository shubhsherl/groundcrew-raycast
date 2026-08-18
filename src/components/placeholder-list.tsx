import { List } from "@raycast/api";

interface PlaceholderListProps {
  description: string;
  isLoading?: boolean;
  title: string;
}

export function PlaceholderList({ description, isLoading = false, title }: PlaceholderListProps) {
  return (
    <List isLoading={isLoading}>
      <List.EmptyView title={title} description={description} />
    </List>
  );
}
