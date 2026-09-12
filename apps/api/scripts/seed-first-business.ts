/**
 * Seed: Onboard Anikanth Studios + Smile Baby Studio
 * Run: npx tsx scripts/seed-first-business.ts
 */

import 'dotenv/config'
import { Pool } from 'pg'

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
})

async function seed() {
  const client = await db.connect()

  try {
    await client.query('BEGIN')

    // ── 1. Owner user ──────────────────────────────────────────────────
    const ownerResult = await client.query(`
      INSERT INTO users (phone, name, is_vendor, is_customer)
      VALUES ('+919618799299', 'Raghavendra', true, true)
      ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, is_vendor = true
      RETURNING id
    `)
    const ownerId = ownerResult.rows[0].id
    console.log('👤 Owner:', ownerId)

    // ── 1b. Vendor profile ─────────────────────────────────────────────
    let vendorId: string
    const existingVendor = await client.query<{ id: string }>(
      `SELECT id FROM vendors WHERE user_id = $1 LIMIT 1`, [ownerId]
    )
    if (existingVendor.rows[0]) {
      vendorId = existingVendor.rows[0].id
      console.log('🏪 Vendor (existing):', vendorId)
    } else {
      const vendorResult = await client.query(`
        INSERT INTO vendors (
          user_id, raw_description, category_tags,
          service_area_description, rating, is_kyc_verified
        ) VALUES (
          $1,
          'Professional photography studio covering weddings, events, portraits, and commercial shoots across Hyderabad.',
          ARRAY['photography', 'videography', 'wedding-photography', 'event-photography', 'baby-photography'],
          'All over Hyderabad',
          4.8, true
        )
        RETURNING id
      `, [ownerId])
      vendorId = vendorResult.rows[0].id
      console.log('🏪 Vendor:', vendorId)
    }

    // ── 2. Anikanth Studios ────────────────────────────────────────────
    const anikanthResult = await client.query(`
      INSERT INTO organizations (
        vendor_id, legal_name, display_name, org_type,
        area, contact_phone,
        verification_status, supported_booking_types
      ) VALUES (
        $1, 'Anikanth Studios', 'Anikanth Studios', 'studio',
        'Hyderabad', '+919618799299',
        'verified', ARRAY['appointment', 'quote']
      )
      RETURNING id
    `, [vendorId])
    const anikanthId = anikanthResult.rows[0].id
    console.log('📸 Anikanth Studios:', anikanthId)

    // Anikanth packages
    const anikanthItems = [
      { name: 'Wedding Photography — Full Day', desc: 'Complete wedding day coverage. 500+ edited photos + online gallery.', price: 25000, section: 'Wedding' },
      { name: 'Wedding Photography — Half Day', desc: 'Half-day wedding coverage. 250+ edited photos.', price: 15000, section: 'Wedding' },
      { name: 'Pre-Wedding Shoot', desc: 'Outdoor/indoor couple shoot. 50+ edited photos, 2 outfit changes.', price: 8000, section: 'Wedding' },
      { name: 'Engagement Photography', desc: 'Full engagement ceremony coverage. 200+ edited photos.', price: 12000, section: 'Wedding' },
      { name: 'Wedding Videography — Full Day', desc: 'Cinematic wedding film + highlight reel.', price: 35000, section: 'Wedding' },
      { name: 'Birthday Party Photography', desc: 'Complete birthday party coverage. 150+ edited photos.', price: 6000, section: 'Events' },
      { name: 'Corporate Event Photography', desc: 'Professional corporate event or product launch coverage.', price: 10000, section: 'Events' },
      { name: 'Portrait Session', desc: 'Individual or family portraits. Studio or outdoor. 20+ edited photos.', price: 4500, section: 'Portraits' },
      { name: 'Product Photography', desc: 'E-commerce product photos. 10 products, 3 angles each.', price: 5000, section: 'Commercial' },
      { name: 'Real Estate Photography', desc: 'Property interior & exterior shots. Up to 2000 sq ft.', price: 4500, section: 'Commercial' },
    ]

    for (let i = 0; i < anikanthItems.length; i++) {
      const item = anikanthItems[i]
      await client.query(`
        INSERT INTO catalog_items (
          organization_id, name, description, price, price_unit,
          section, is_available, display_order
        ) VALUES ($1, $2, $3, $4, 'INR', $5, true, $6)
      `, [anikanthId, item.name, item.desc, item.price, item.section, i + 1])
    }
    console.log(`  📋 ${anikanthItems.length} packages`)

    // Anikanth photographers
    await client.query(`
      INSERT INTO bookable_resources (
        organization_id, resource_type, name, description,
        specialization, base_price, is_active, display_order
      ) VALUES
        ($1, 'person', 'Lead Photographer', 'Senior photographer, 8+ years experience. Candid and cinematic styles.', 'Wedding & Events Photography', 4500, true, 1),
        ($1, 'person', 'Portrait Specialist', 'Studio and outdoor portrait expert. Great with kids and families.', 'Portraits & Baby Photography', 4500, true, 2),
        ($1, 'person', 'Lead Videographer', 'Cinematic wedding films and highlight reels. 4K capability.', 'Wedding Cinema & Videography', 8000, true, 3)
    `, [anikanthId])
    console.log('  👥 3 resources')

    // ── 3. Smile Baby Studio ───────────────────────────────────────────
    const smileResult = await client.query(`
      INSERT INTO organizations (
        vendor_id, legal_name, display_name, org_type,
        area, contact_phone,
        verification_status, supported_booking_types
      ) VALUES (
        $1, 'Smile Baby Studio', 'Smile Baby Studio', 'studio',
        'Hyderabad', '+919618799299',
        'verified', ARRAY['appointment']
      )
      RETURNING id
    `, [vendorId])
    const smileId = smileResult.rows[0].id
    console.log('👶 Smile Baby Studio:', smileId)

    // Smile Baby packages
    const smileItems = [
      { name: 'Newborn Photoshoot', desc: 'Studio newborn session with props and wraps. Best within 15 days of birth. 30+ photos.', price: 6000, section: 'Baby' },
      { name: 'Pre-Birthday Shoot', desc: 'Themed pre-birthday photoshoot. Cake smash, balloons, custom backdrops. 40+ photos.', price: 5000, section: 'Baby' },
      { name: 'Baby Milestone Shoot', desc: 'Capture baby milestones — 3, 6, 9 months. Studio session with themed props.', price: 4500, section: 'Baby' },
      { name: 'Maternity Photoshoot', desc: 'Beautiful maternity portraits. Studio or outdoor. Drapes and gowns. 30+ photos.', price: 5500, section: 'Maternity' },
      { name: 'Birthday Party Photography', desc: 'Complete birthday party coverage at your venue. 150+ photos.', price: 6000, section: 'Events' },
      { name: 'Family Portrait Session', desc: 'Family photoshoot with themed backdrops. Up to 5 members. 25+ photos.', price: 4500, section: 'Family' },
      { name: 'Naming Ceremony Photography', desc: 'Naming / cradle ceremony coverage. 100+ edited photos.', price: 5000, section: 'Events' },
      { name: 'Half Saree Ceremony', desc: 'Voni function / half saree ceremony photography. 150+ photos.', price: 7000, section: 'Events' },
    ]

    for (let i = 0; i < smileItems.length; i++) {
      const item = smileItems[i]
      await client.query(`
        INSERT INTO catalog_items (
          organization_id, name, description, price, price_unit,
          section, is_available, display_order
        ) VALUES ($1, $2, $3, $4, 'INR', $5, true, $6)
      `, [smileId, item.name, item.desc, item.price, item.section, i + 1])
    }
    console.log(`  📋 ${smileItems.length} packages`)

    // Smile Baby photographers
    await client.query(`
      INSERT INTO bookable_resources (
        organization_id, resource_type, name, description,
        specialization, base_price, is_active, display_order
      ) VALUES
        ($1, 'person', 'Baby Specialist', 'Expert in newborn and baby photography. Gentle, creative, patient.', 'Newborn & Baby Photography', 4500, true, 1),
        ($1, 'person', 'Maternity & Family', 'Specializes in maternity portraits and family sessions.', 'Maternity & Family Photography', 4500, true, 2)
    `, [smileId])
    console.log('  👥 2 resources')

    // ── 4. Offers ──────────────────────────────────────────────────────
    await client.query(`
      INSERT INTO offers (
        organization_id, offer_type, title, description,
        discount_value, discount_type, badge_text,
        start_date, is_active, is_featured
      ) VALUES
        ($1, 'percent_discount', 'Wedding Season Special',
         'Book wedding photography and get 10% off! Dec-Feb weddings.',
         10, 'percent', '10% OFF',
         CURRENT_DATE, true, true),
        ($2, 'flat_discount', 'First Baby Shoot Gift',
         'Book any baby photoshoot and get a free 8x12 framed print worth ₹500!',
         500, 'flat', 'FREE GIFT',
         CURRENT_DATE, true, true)
    `, [anikanthId, smileId])
    console.log('🎁 2 offers')

    await client.query('COMMIT')

    console.log('\n✅ Both studios onboarded!')
    console.log(`\n   Anikanth Studios: ${anikanthId}`)
    console.log(`   Smile Baby Studio: ${smileId}`)
    console.log(`   Owner: ${ownerId} (+919618799299)`)

  } catch (err) {
    await client.query('ROLLBACK')
    console.error('❌ Seed failed:', err)
    throw err
  } finally {
    client.release()
    await db.end()
  }
}

seed().catch(() => process.exit(1))
