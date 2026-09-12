import BusinessProfile from "@/components/business";
export default function Page({ params }: { params: { orgId: string } }) {
  return <BusinessProfile orgId={params.orgId} />;
}
