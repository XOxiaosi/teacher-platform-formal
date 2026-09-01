const currencyFormatter = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function formatCurrency(value: number): string {
  return currencyFormatter.format(value).replace('CN¥', '¥');
}

export function formatLessonCount(value: number): string {
  return `${value} 课时`;
}
